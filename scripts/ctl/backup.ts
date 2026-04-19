import { confirm } from "@inquirer/prompts";
import { heading, label, requireConfig, success, value } from "./context";
import { configBoolean, configString, normalizeS3Endpoint, runAllowFailure, runInteractive, runText } from "../lib/common";
import { backupExportCmd } from "../terrarium-s3-export";
import { reconstructFromS3 } from "../terrarium-zfs-reconstruct";
import { PREFIX } from "./context";

/**
 * Lists local ZFS restore points and remote S3 manifests for the active host.
 *
 * The output stays intentionally raw and grep-friendly because this command is
 * often used as a quick operator inspection tool before a restore.
 */
export async function backupListCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const bucket = configString(config, "terrarium_s3_bucket");
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const endpoint = normalizeS3Endpoint(configString(config, "terrarium_s3_endpoint"));
  const awsEnv: Record<string, string> = {};
  const accessKey = configString(config, "terrarium_s3_access_key");
  const secretKey = configString(config, "terrarium_s3_secret_key");
  const region = configString(config, "terrarium_s3_region", "us-east-1");
  if (accessKey) awsEnv.AWS_ACCESS_KEY_ID = accessKey;
  if (secretKey) awsEnv.AWS_SECRET_ACCESS_KEY = secretKey;
  if (region) awsEnv.AWS_DEFAULT_REGION = region;
  awsEnv.AWS_EC2_METADATA_DISABLED = "true";
  const awsBase = ["aws"];
  if (endpoint) {
    awsBase.push("--endpoint-url", endpoint);
  }

  console.log(heading("Local ZFS snapshots"));
  const snapshotsRaw = await runAllowFailure(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"]);
  const snapshots = snapshotsRaw.stdout
    .split("\n")
    .filter((line) => line.startsWith(`${pool}/containers/`))
    .filter(Boolean);
  if (snapshots.length > 0) {
    console.log(snapshots.join("\n"));
  }

  if (configBoolean(config, "terrarium_enable_s3") && bucket) {
    console.log(`\n${heading("S3 manifests")}`);
    const output = (
      await runAllowFailure([...awsBase, "s3", "ls", `s3://${bucket}/${prefix}/manifests/`, "--recursive"], { env: awsEnv })
    ).stdout.trim();
    if (output) {
      console.log(output);
    }
  }
}

/** Prompts before destructive restore operations that overwrite current state. */
async function confirmDestructive(message: string): Promise<void> {
  const approved = await confirm({ message, default: false });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

/**
 * Prints the explicit operator handoff for restore-as-new flows.
 *
 * Terrarium automates dataset reconstruction, but LXD still requires an
 * interactive `lxd recover` step to import the recovered volume as an instance.
 */
function printAsNewRecoveryNotice(pool: string, dataset: string, instanceName: string): void {
  console.log(`\n${heading("Manual LXD Import Required")}`);
  console.log("Terrarium restored the ZFS dataset, but LXD has not imported it as an instance yet.");
  console.log("This step is interactive in upstream LXD and cannot be completed non-interactively.");
  console.log(`${label("Recovered dataset:")} ${value(dataset)}`);
  console.log(`${label("Target instance name:")} ${value(instanceName)}`);
  console.log(`${label("Next steps:")} 1) Terrarium will now start ${value("lxd recover")}`);
  console.log(`            2) Select storage pool ${value(pool)} when prompted`);
  console.log(`            3) Import the recovered volume as instance ${value(instanceName)}`);
  console.log(`            4) Verify it with ${value(`lxc list ${instanceName}`)}`);
}

/** Starts the upstream interactive LXD recovery flow after Terrarium has prepared the dataset. */
async function handOffToLxdRecover(): Promise<void> {
  console.log(`\n${label("Starting:")} ${value("lxd recover")}`);
  await runInteractive(["lxd", "recover"], PREFIX);
}

/** Finds the newest snapshot that matches the requested dataset and optional selector. */
async function findSnapshot(dataset: string, query = ""): Promise<string> {
  const stdout = await runText(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"], PREFIX);
  let match = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${dataset}@`) && (!query || line.includes(query))) {
      match = line.trim();
    }
  }
  return match;
}

/** Restores a local ZFS snapshot either in-place or into a new importable dataset. */
async function restoreLocal(
  instance: string,
  at: string,
  mode: "in-place" | "as-new",
  newName: string,
  pool: string
): Promise<void> {
  const dataset = `${pool}/containers/${instance}`;
  const snapshot = await findSnapshot(dataset, at);
  if (!snapshot) {
    throw new Error(at ? `no local snapshot matched '${at}'` : `no local snapshots found for '${instance}'`);
  }

  if (mode === "in-place") {
    await confirmDestructive(`Rollback ${instance} in place to ${snapshot}?`);
    await runAllowFailure(["lxc", "stop", instance, "--force"]);
    await runText(["zfs", "rollback", "-r", snapshot], PREFIX);
    console.log(success(`Rolled back ${instance} to ${snapshot}`));
    console.log(`${label("Next:")} ${value(`lxc start ${instance}`)}`);
    return;
  }

  if (!newName) {
    throw new Error("--as-new requires a target name");
  }

  const targetDataset = `${pool}/containers/${newName}`;
  await runText(["zfs", "clone", snapshot, targetDataset], PREFIX);
  console.log(success(`Cloned ${snapshot} to ${targetDataset}`));
  printAsNewRecoveryNotice(pool, targetDataset, newName);
  await handOffToLxdRecover();
}

/** Restores an S3-backed dataset chain either in-place or into a new importable dataset. */
async function restoreS3(
  instance: string,
  at: string,
  mode: "in-place" | "as-new",
  newName: string,
  pool: string
): Promise<void> {
  const target = mode === "in-place" ? `${pool}/containers/${instance}` : `${pool}/containers/${newName}`;
  if (mode === "in-place") {
    await confirmDestructive(`Reconstruct ${instance} in place into ${target}?`);
    await runAllowFailure(["lxc", "stop", instance, "--force"]);
  } else if (!newName) {
    throw new Error("--as-new requires a target name");
  }

  await reconstructFromS3(instance, at, target);
  if (mode === "in-place") {
    console.log(success(`Reconstructed dataset for ${instance} into ${target}`));
    console.log(`${label("Next:")} ${value(`lxc start ${instance}`)}`);
  } else {
    console.log(success(`Reconstructed dataset into ${target}`));
    printAsNewRecoveryNotice(pool, target, newName);
    await handOffToLxdRecover();
  }
}

/**
 * Dispatches the Terrarium backup command family.
 *
 * This keeps the main CLI registration thin while preserving a single backup
 * command surface for list/export/restore.
 */
export async function backupActionCmd(
  action: string,
  options: { source?: string; instance?: string; at?: string; asNew?: string }
): Promise<void> {
  if (action === "list") {
    await backupListCmd();
    return;
  }

  if (action === "export") {
    await backupExportCmd();
    return;
  }

  if (action !== "restore") {
    throw new Error(`unsupported backup action: ${action}`);
  }

  const source = options.source || "local";
  const instance = options.instance;
  const at = options.at || "";
  const newName = options.asNew ?? "";
  if (!instance) {
    throw new Error("backup restore requires --instance; --source defaults to local, --at defaults to the latest restore point, and --as-new is optional");
  }

  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const mode = newName ? "as-new" : "in-place";

  if (source === "local") {
    await restoreLocal(instance, at, mode, newName, pool);
    return;
  }
  if (source === "s3") {
    await restoreS3(instance, at, mode, newName, pool);
    return;
  }

  throw new Error(`unsupported restore source: ${source}`);
}
