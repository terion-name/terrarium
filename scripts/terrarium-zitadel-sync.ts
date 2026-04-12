import { existsSync } from "node:fs";
import { configString, loadConfig, readJsonFile, runText, writeIfChanged } from "./lib/common";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const DEFAULT_BOOTSTRAP_DIR = "/var/lib/terrarium/zitadel/bootstrap";
const DEFAULT_TF_DIR = "/var/lib/terrarium/zitadel/terraform";
const DEFAULT_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
const DEFAULT_TOFU_IMAGE = "ghcr.io/opentofu/opentofu:1.10.6";

async function dockerRun(args: string[]): Promise<string> {
  return await runText(["docker", ...args], PREFIX);
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (configString(config, "terrarium_idp_mode") !== "zitadel_self_hosted") {
    return;
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  const bootstrapDir = configString(config, "terrarium_zitadel_bootstrap_dir", DEFAULT_BOOTSTRAP_DIR);
  const tfDir = configString(config, "terrarium_zitadel_tf_dir", DEFAULT_TF_DIR);
  const outputsPath = configString(config, "terrarium_zitadel_outputs_path", DEFAULT_OUTPUTS_PATH);
  const tofuImage = configString(config, "terrarium_zitadel_tofu_image", DEFAULT_TOFU_IMAGE);

  if (!authDomain) {
    throw new Error("terrarium_auth_domain is empty");
  }
  if (!existsSync(`${bootstrapDir}/admin-sa.json`)) {
    throw new Error(`missing bootstrap machine key: ${bootstrapDir}/admin-sa.json`);
  }
  if (!existsSync(tfDir)) {
    throw new Error(`terraform directory not found: ${tfDir}`);
  }

  const commonArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "--add-host",
    `${authDomain}:127.0.0.1`,
    "-v",
    `${tfDir}:/workspace`,
    "-v",
    `${bootstrapDir}:/secrets:ro`,
    "-w",
    "/workspace",
    tofuImage
  ];

  await dockerRun([...commonArgs, "init", "-input=false"]);
  await dockerRun([...commonArgs, "apply", "-input=false", "-auto-approve"]);
  const outputsJson = await dockerRun([...commonArgs, "output", "-json"]);
  writeIfChanged(outputsPath, outputsJson.endsWith("\n") ? outputsJson : `${outputsJson}\n`);

  const outputs = readJsonFile<Record<string, { value?: string }>>(outputsPath, {});
  const lxdClientId = outputs.lxd_client_id?.value ?? "";
  if (lxdClientId && existsSync("/snap/bin/lxc")) {
    await runText(["/snap/bin/lxc", "config", "set", "oidc.issuer", `https://${authDomain}/`], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdClientId], PREFIX);
  }
}
