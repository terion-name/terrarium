import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configBoolean,
  configString,
  loadConfig,
  normalizeS3Endpoint,
  runAllowFailure,
  runJson,
  runText,
  shellEscape,
  writeJsonFile
} from "./lib/common";

const PREFIX = "terrariumctl backup export";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const STATE_DIR = "/var/lib/terrarium";
const S3_EXPORT_ATTEMPTS = 4;
const S3_EXPORT_RETRY_MS = 5000;

type LxcInstance = {
  name: string;
  type?: string;
};

function s3Env(config: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {};
  const accessKey = configString(config, "terrarium_s3_access_key");
  const secretKey = configString(config, "terrarium_s3_secret_key");
  const region = configString(config, "terrarium_s3_region", "us-east-1");
  if (accessKey) env.AWS_ACCESS_KEY_ID = accessKey;
  if (secretKey) env.AWS_SECRET_ACCESS_KEY = secretKey;
  if (region) env.AWS_DEFAULT_REGION = region;
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_RETRY_MODE = "standard";
  env.AWS_MAX_ATTEMPTS = "5";
  return env;
}

export function chooseLatestExportSnapshot(snapshotNames: string[], dataset: string): string {
  let latest = "";
  for (const snapshot of snapshotNames) {
    const trimmed = snapshot.trim();
    if (!trimmed.startsWith(`${dataset}@`)) {
      continue;
    }
    const snapshotName = trimmed.split("@").at(-1) ?? "";
    if (/(^|_)frequently$/.test(snapshotName)) {
      continue;
    }
    latest = trimmed;
  }
  return latest;
}

async function latestSnapshot(dataset: string): Promise<string> {
  const stdout = await runText(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"], PREFIX);
  return chooseLatestExportSnapshot(stdout.split("\n"), dataset);
}

export function zfsReplicationSendCommand(latestSnapshot: string, parentSnapshot = ""): string {
  if (parentSnapshot) {
    return `zfs send -R -I ${shellEscape(parentSnapshot)} ${shellEscape(latestSnapshot)}`;
  }
  return `zfs send -R ${shellEscape(latestSnapshot)}`;
}

export function isRetriableS3ExportError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "gatewaytimeout",
    "gateway timeout",
    "uploadpart",
    "requesttimeout",
    "request timeout",
    "slowdown",
    "service unavailable",
    "connection reset",
    "connection broken",
    "connection aborted",
    "timeout",
    "timed out",
    "503",
    "504"
  ].some((needle) => lowered.includes(needle));
}

function formatCommandFailure(result: Awaited<ReturnType<typeof runAllowFailure>>): string {
  const parts = [`exit code ${result.exitCode}`];
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) {
    parts.push(`stdout:\n${stdout}`);
  }
  if (stderr) {
    parts.push(`stderr:\n${stderr}`);
  }
  return parts.join("\n\n");
}

async function runRetriableS3Command(command: string, awsEnv: Record<string, string>, label: string): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= S3_EXPORT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(["bash", "-lc", `set -o pipefail; ${command}`], { env: awsEnv });
    if (result.exitCode === 0) {
      return;
    }

    lastError = formatCommandFailure(result);
    if (attempt >= S3_EXPORT_ATTEMPTS || !isRetriableS3ExportError(lastError)) {
      throw new Error(lastError);
    }

    console.warn(`${PREFIX}: ${label} failed on attempt ${attempt}; retrying: ${lastError}`);
    await Bun.sleep(S3_EXPORT_RETRY_MS);
  }

  throw new Error(lastError || `${label} failed`);
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

  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const awsEnv = s3Env(config);
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
        ? zfsReplicationSendCommand(latest, last)
        : zfsReplicationSendCommand(latest);

    await runRetriableS3Command(
      `${streamSource} | zstd -T0 | ${awsBase.map(shellEscape).join(" ")} s3 cp - ${shellEscape(`s3://${bucket}/${objectKey}`)}`,
      awsEnv,
      `S3 stream upload for ${instance.name}@${snapName}`
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
    await runRetriableS3Command(
      `${awsBase.map(shellEscape).join(" ")} s3 cp ${shellEscape(manifestPath)} ${shellEscape(`s3://${bucket}/${manifestKey}`)}`,
      awsEnv,
      `S3 manifest upload for ${instance.name}@${snapName}`
    );
    writeFileSync(stateFile, `${latest}\n`, "utf8");
  }
}
