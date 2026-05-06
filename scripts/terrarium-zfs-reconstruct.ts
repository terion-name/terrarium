import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  configString,
  loadConfig,
  makeTempDir,
  normalizeS3Endpoint,
  readJsonFile,
  removePath,
  runAllowFailure,
  runText,
  shellEscape
} from "./lib/common";

const PREFIX = "terrariumctl backup reconstruct";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const S3_RESTORE_ATTEMPTS = 3;
const S3_RESTORE_RETRY_MS = 5000;
const ZFS_DESTROY_ATTEMPTS = 5;
const ZFS_DESTROY_RETRY_MS = 2000;

type Manifest = {
  snapshot: string;
  parent_snapshot?: string;
  object_key: string;
  created_at: string;
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
  return env;
}

function selectChain(directory: string, match = ""): Manifest[] {
  const manifests: Manifest[] = [];
  for (const entry of new Bun.Glob("*.json").scanSync(directory)) {
    manifests.push(readJsonFile<Manifest>(join(directory, entry), {} as Manifest));
  }
  manifests.sort((left, right) => left.created_at.localeCompare(right.created_at));

  let selected: Manifest | undefined;
  for (const item of manifests) {
    if (!match || item.snapshot.includes(match) || item.created_at.includes(match)) {
      selected = item;
    }
  }
  if (!selected) {
    throw new Error("no matching manifest chain found");
  }

  const bySnapshot = new Map(manifests.map((item) => [item.snapshot, item]));
  const chain: Manifest[] = [];
  let current: Manifest | undefined = selected;
  while (current) {
    chain.push(current);
    current = current.parent_snapshot ? bySnapshot.get(current.parent_snapshot) : undefined;
  }
  chain.reverse();
  return chain;
}

export function isRetriableS3RestoreError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "incompleteread",
    "incomplete stream",
    "premature end",
    "connection broken",
    "connection reset",
    "read error",
    "broken pipe",
    "timeout",
    "timed out",
    "slowdown",
    "http 503",
    "http 504",
    "service unavailable",
    "gateway timeout"
  ].some((needle) => lowered.includes(needle));
}

export function isRetriableZfsDestroyError(message: string): boolean {
  const lowered = message.toLowerCase();
  return ["dataset is busy", "device or resource busy", "target is busy", "filesystem is busy"].some((needle) => lowered.includes(needle));
}

function formatPipelineFailure(result: Awaited<ReturnType<typeof runAllowFailure>>): string {
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

async function destroyDatasetIfExists(targetDataset: string): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= ZFS_DESTROY_ATTEMPTS; attempt += 1) {
    const datasetCheck = await runAllowFailure(["zfs", "list", "-H", targetDataset]);
    if (datasetCheck.exitCode !== 0) {
      return;
    }

    await unmountDatasetsUnder(targetDataset);
    const destroy = await runAllowFailure(["zfs", "destroy", "-r", "-f", targetDataset]);
    if (destroy.exitCode === 0) {
      return;
    }

    lastError = formatPipelineFailure(destroy);
    if (attempt >= ZFS_DESTROY_ATTEMPTS || !isRetriableZfsDestroyError(lastError)) {
      throw new Error(lastError);
    }
    console.warn(`${PREFIX}: target dataset was busy on destroy attempt ${attempt}; retrying: ${lastError}`);
    await Bun.sleep(ZFS_DESTROY_RETRY_MS);
  }

  throw new Error(lastError || `failed to destroy ${targetDataset}`);
}

async function unmountDatasetsUnder(targetDataset: string): Promise<void> {
  const result = await runAllowFailure(["zfs", "list", "-H", "-r", "-o", "name,mounted", targetDataset]);
  if (result.exitCode !== 0) {
    return;
  }

  const mountedDatasets = result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 2 && columns[1] === "yes")
    .map((columns) => columns[0] as string)
    .sort((left, right) => right.length - left.length);

  for (const dataset of mountedDatasets) {
    await runAllowFailure(["zfs", "unmount", "-f", dataset]);
  }
}

async function receiveS3Chain(
  chain: Manifest[],
  awsBase: string[],
  bucket: string,
  targetDataset: string,
  awsEnv: Record<string, string>
): Promise<void> {
  let lastError = "";
  for (let attempt = 1; attempt <= S3_RESTORE_ATTEMPTS; attempt += 1) {
    await destroyDatasetIfExists(targetDataset);

    try {
      for (const manifest of chain) {
        const command = `set -o pipefail; ${awsBase.map(shellEscape).join(" ")} s3 cp ${shellEscape(`s3://${bucket}/${manifest.object_key}`)} - | zstd -d | zfs receive -F ${shellEscape(targetDataset)}`;
        const result = await runAllowFailure(["bash", "-lc", command], { env: awsEnv });
        if (result.exitCode !== 0) {
          throw new Error(formatPipelineFailure(result));
        }
      }
      return;
    } catch (error) {
      lastError = String(error).replace(/^Error: /, "");
      if (attempt >= S3_RESTORE_ATTEMPTS || !isRetriableS3RestoreError(lastError)) {
        throw new Error(lastError);
      }
      console.warn(`${PREFIX}: S3 restore stream failed on attempt ${attempt}; retrying: ${lastError}`);
      await Bun.sleep(S3_RESTORE_RETRY_MS);
    }
  }

  throw new Error(lastError || "S3 restore failed");
}

export async function reconstructFromS3(instance: string, at: string, targetDataset: string, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  const bucket = configString(config, "terrarium_s3_bucket");
  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const awsEnv = s3Env(config);
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  const tempDir = makeTempDir("terrarium-restore.");
  try {
    await runText([...awsBase, "s3", "cp", `s3://${bucket}/${prefix}/manifests/${instance}/`, `${tempDir}/`, "--recursive"], PREFIX, {
      env: awsEnv
    });
    const chain = selectChain(tempDir, at);

    await receiveS3Chain(chain, awsBase, bucket, targetDataset, awsEnv);
  } finally {
    if (existsSync(tempDir)) {
      removePath(tempDir);
    }
  }
}
