import { existsSync } from "node:fs";
import { join } from "node:path";
import { configString, loadConfig, makeTempDir, readJsonFile, removePath, runAllowFailure, runShell, runText, shellEscape } from "./lib/common";

const PREFIX = "terrariumctl backup reconstruct";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";

type Manifest = {
  snapshot: string;
  parent_snapshot?: string;
  object_key: string;
  created_at: string;
};

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

export async function reconstructFromS3(instance: string, at: string, targetDataset: string, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  const bucket = configString(config, "terrarium_s3_bucket");
  const endpoint = configString(config, "terrarium_s3_endpoint");
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  const tempDir = makeTempDir("terrarium-restore.");
  try {
    await runText([...awsBase, "s3", "cp", `s3://${bucket}/${prefix}/manifests/${instance}/`, `${tempDir}/`, "--recursive"], PREFIX);
    const chain = selectChain(tempDir, at);

    const datasetCheck = await runAllowFailure(["zfs", "list", "-H", targetDataset]);
    if (datasetCheck.exitCode === 0) {
      await runText(["zfs", "destroy", "-r", targetDataset], PREFIX);
    }

    for (const manifest of chain) {
      await runShell(
        `${awsBase.map(shellEscape).join(" ")} s3 cp ${shellEscape(`s3://${bucket}/${manifest.object_key}`)} - | zstd -d | zfs receive -F ${shellEscape(targetDataset)}`,
        PREFIX
      );
    }
  } finally {
    if (existsSync(tempDir)) {
      removePath(tempDir);
    }
  }
}
