import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configBoolean, configString, loadConfig, runAllowFailure, runJson, runShell, runText, shellEscape, writeJsonFile } from "./lib/common";

const PREFIX = "terrariumctl backup export";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const STATE_DIR = "/var/lib/terrarium";

type LxcInstance = {
  name: string;
  type?: string;
};

async function latestSnapshot(dataset: string): Promise<string> {
  const stdout = await runText(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"], PREFIX);
  let latest = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${dataset}@`)) {
      latest = line.trim();
    }
  }
  return latest;
}

export async function backupExportCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (!configBoolean(config, "terrarium_enable_s3")) {
    return;
  }

  const bucket = configString(config, "terrarium_s3_bucket");
  if (!bucket) {
    return;
  }

  const endpoint = configString(config, "terrarium_s3_endpoint");
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  mkdirSync(join(STATE_DIR, "catalog"), { recursive: true });
  mkdirSync(join(STATE_DIR, "lastsnapshots"), { recursive: true });

  const instances = await runJson<LxcInstance[]>(["lxc", "list", "--format", "json"], PREFIX);
  for (const instance of instances) {
    if ((instance.type ?? "container") !== "container") {
      continue;
    }

    const dataset = `${pool}/containers/${instance.name}`;
    const latest = await latestSnapshot(dataset);
    if (!latest) {
      continue;
    }

    const stateFile = join(STATE_DIR, "lastsnapshots", `${instance.name}.txt`);
    const last = existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "";
    if (last === latest) {
      continue;
    }

    const snapName = latest.split("@").at(-1) ?? latest;
    const objectKey = `${prefix}/streams/${instance.name}/${snapName}.zfs.zst`;
    const manifestKey = `${prefix}/manifests/${instance.name}/${snapName}.json`;
    const manifestDir = join(STATE_DIR, "catalog", instance.name);
    const manifestPath = join(manifestDir, `${snapName}.json`);
    mkdirSync(manifestDir, { recursive: true });

    const streamSource =
      last && (await runAllowFailure(["zfs", "list", "-H", "-t", "snapshot", last])).exitCode === 0
        ? `zfs send -I ${shellEscape(last)} ${shellEscape(latest)}`
        : `zfs send ${shellEscape(latest)}`;

    await runShell(
      `${streamSource} | zstd -T0 | ${awsBase.map(shellEscape).join(" ")} s3 cp - ${shellEscape(`s3://${bucket}/${objectKey}`)}`,
      PREFIX
    );

    const manifest = {
      instance: instance.name,
      dataset,
      snapshot: latest,
      parent_snapshot: last,
      object_key: objectKey,
      full: !last,
      created_at: new Date().toISOString()
    };
    writeJsonFile(manifestPath, manifest);
    await runText([...awsBase, "s3", "cp", manifestPath, `s3://${bucket}/${manifestKey}`], PREFIX);
    writeFileSync(stateFile, `${latest}\n`, "utf8");
  }
}
