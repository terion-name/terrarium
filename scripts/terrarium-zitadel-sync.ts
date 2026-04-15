import { existsSync } from "node:fs";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged } from "./lib/common";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const DEFAULT_ZITADEL_DIR = "/var/lib/terrarium/zitadel";
const DEFAULT_BOOTSTRAP_DIR = "/var/lib/terrarium/zitadel/bootstrap";
const DEFAULT_TF_DIR = "/var/lib/terrarium/zitadel/terraform";
const DEFAULT_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
const DEFAULT_TOFU_IMAGE = "ghcr.io/opentofu/opentofu:1.10.6";
const WAIT_INTERVAL_MS = 5000;
const WAIT_ATTEMPTS = 36;

async function dockerRun(args: string[]): Promise<string> {
  return await runText(["docker", ...args], PREFIX);
}

async function waitForFile(path: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${label}: ${path}`);
}

async function waitForApiReady(stackDir: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(
      [
        "docker",
        "compose",
        "--project-name",
        "terrarium-zitadel",
        "-f",
        `${stackDir}/docker-compose.yml`,
        "exec",
        "-T",
        "zitadel-api",
        "/app/zitadel",
        "ready"
      ],
      { cwd: stackDir }
    );
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "container is not ready yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ZITADEL API readiness: ${lastError}`);
}

async function waitForHttpsDiscovery(authDomain: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure([
      "curl",
      "-fsS",
      `https://${authDomain}/.well-known/openid-configuration`
    ]);
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "OIDC discovery is not reachable yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for HTTPS OIDC discovery on ${authDomain}: ${lastError}`);
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (configString(config, "terrarium_idp_mode") !== "local") {
    return;
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  const zitadelDir = configString(config, "terrarium_zitadel_dir") || DEFAULT_ZITADEL_DIR;
  const bootstrapDir = configString(config, "terrarium_zitadel_bootstrap_dir") || DEFAULT_BOOTSTRAP_DIR;
  const tfDir = configString(config, "terrarium_zitadel_tf_dir") || DEFAULT_TF_DIR;
  const outputsPath = configString(config, "terrarium_zitadel_outputs_path") || DEFAULT_OUTPUTS_PATH;
  const tofuImage = configString(config, "terrarium_zitadel_tofu_image") || DEFAULT_TOFU_IMAGE;

  if (!authDomain) {
    throw new Error("terrarium_auth_domain is empty");
  }
  if (!existsSync(tfDir)) {
    throw new Error(`terraform directory not found: ${tfDir}`);
  }

  await waitForFile(`${bootstrapDir}/admin-sa.json`, "bootstrap machine key");
  await waitForFile(`${bootstrapDir}/login-client.pat`, "login client PAT");
  await waitForApiReady(zitadelDir);
  await waitForHttpsDiscovery(authDomain);

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
    const issuer = configString(config, "terrarium_oidc_issuer") || `https://${authDomain}/`;
    await runText(["/snap/bin/lxc", "config", "set", "oidc.issuer", issuer], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdClientId], PREFIX);
  }
}
