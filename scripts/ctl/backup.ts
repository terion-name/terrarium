import { confirm } from "@inquirer/prompts";
import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { heading, label, requireConfig, success, value } from "./context";
import { JsonRecord, configBoolean, configString, normalizeS3Endpoint, runAllowFailure, runInteractive, runText } from "../lib/common";
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

async function stopInstanceForRestore(instance: string): Promise<void> {
  await runAllowFailure(["lxc", "stop", instance, "--force"]);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const info = await runAllowFailure(["lxc", "info", instance]);
    if (info.exitCode !== 0 || /Status:\s+STOPPED\b/.test(info.stdout)) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${instance} to stop before restore`);
}

type CommandRunner = typeof runAllowFailure;

export async function assertNewRestoreTargetIsUnused(instance: string, targetDataset: string, runCommand: CommandRunner = runAllowFailure): Promise<void> {
  const instanceCheck = await runCommand(["lxc", "info", instance]);
  if (instanceCheck.exitCode === 0) {
    throw new Error(`restore target instance '${instance}' already exists; choose a different --as-new name`);
  }

  const datasetCheck = await runCommand(["zfs", "list", "-H", targetDataset]);
  if (datasetCheck.exitCode === 0) {
    throw new Error(`restore target dataset '${targetDataset}' already exists; choose a different --as-new name`);
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
  console.log("Terrarium restored the ZFS dataset and prepared its LXD recovery metadata.");
  console.log("LXD recovery is still interactive upstream, so Terrarium will drive you through that handoff and then verify the import.");
  console.log(`${label("Recovered dataset:")} ${value(dataset)}`);
  console.log(`${label("Target instance name:")} ${value(instanceName)}`);
  console.log(`${label("Next steps:")} 1) Terrarium will now start ${value("lxd recover")}`);
  console.log(`            2) Select storage pool ${value(pool)} when prompted`);
  console.log(`            3) Import the recovered volume as instance ${value(instanceName)}`);
  console.log(`            4) Terrarium verifies the import with ${value(`lxc info ${instanceName}`)}`);
}

/** Starts the upstream interactive LXD recovery flow after Terrarium has prepared the dataset. */
async function handOffToLxdRecover(): Promise<void> {
  console.log(`\n${label("Starting:")} ${value("lxd recover")}`);
  await runInteractive(["lxd", "recover"], PREFIX);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lxdStorageRoot(pool: string): string {
  for (const root of ["/var/snap/lxd/common/lxd/storage-pools", "/var/lib/lxd/storage-pools"]) {
    const path = join(root, pool);
    if (existsSync(path)) {
      return path;
    }
  }
  return join("/var/snap/lxd/common/lxd/storage-pools", pool);
}

function rewriteNameReferences(value: unknown, oldName: string, newName: string): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (value.includes(oldName)) {
      return { value: value.replaceAll(oldName, newName), changed: true };
    }
    return { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = rewriteNameReferences(item, oldName, newName);
      changed = result.changed || changed;
      return result.value;
    });
    return { value: next, changed };
  }

  if (isRecord(value)) {
    let changed = false;
    const next: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) {
      const result = rewriteNameReferences(item, oldName, newName);
      changed = result.changed || changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }

  return { value, changed: false };
}

function scrubGeneratedLxdIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubGeneratedLxdIdentity(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "config" && isRecord(item)) {
      next[key] = Object.fromEntries(Object.entries(item).filter(([configKey]) => !configKey.startsWith("volatile.")));
      continue;
    }

    if (key === "devices" && isRecord(item)) {
      next[key] = Object.fromEntries(
        Object.entries(item).map(([deviceName, device]) => {
          if (!isRecord(device)) {
            return [deviceName, scrubGeneratedLxdIdentity(device)];
          }
          const scrubbedDevice = { ...device };
          delete scrubbedDevice.hwaddr;
          return [deviceName, scrubGeneratedLxdIdentity(scrubbedDevice)];
        })
      );
      continue;
    }

    next[key] = scrubGeneratedLxdIdentity(item);
  }

  return next;
}

function scrubRestoreAsNewHostState(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubRestoreAsNewHostState(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "config" && isRecord(item)) {
      next[key] = Object.fromEntries(Object.entries(item).filter(([configKey]) => configKey !== "user.proxy"));
      continue;
    }

    if (key === "devices" && isRecord(item)) {
      next[key] = Object.fromEntries(
        Object.entries(item)
          .filter(([, device]) => !(isRecord(device) && device.type === "proxy"))
          .map(([deviceName, device]) => [deviceName, scrubRestoreAsNewHostState(device)])
      );
      continue;
    }

    next[key] = scrubRestoreAsNewHostState(item);
  }

  return next;
}

export function rewriteRecoveredBackupMetadata(backup: JsonRecord, oldName: string, newName: string): JsonRecord {
  const renamed = rewriteNameReferences(backup, oldName, newName);
  if (!renamed.changed) {
    throw new Error(`recovered LXD backup metadata did not reference source instance '${oldName}'`);
  }
  return scrubRestoreAsNewHostState(scrubGeneratedLxdIdentity(renamed.value)) as JsonRecord;
}

function rewriteBackupYaml(mountPath: string, oldName: string, newName: string): void {
  const backupPath = join(mountPath, "backup.yaml");
  if (!existsSync(backupPath)) {
    throw new Error(`recovered LXD dataset is missing backup.yaml at ${backupPath}`);
  }

  const backup = parse(readFileSync(backupPath, "utf8")) as unknown;
  if (!isRecord(backup)) {
    throw new Error(`recovered LXD backup metadata is not an object: ${backupPath}`);
  }

  try {
    writeFileSync(backupPath, stringify(rewriteRecoveredBackupMetadata(backup, oldName, newName)));
  } catch (error) {
    const message = String(error).replace(/^Error: /, "");
    throw new Error(message.includes(backupPath) ? message : `${message}: ${backupPath}`);
  }
}

function directoryHasEntries(path: string): boolean {
  return existsSync(path) && readdirSync(path).length > 0;
}

function prepareRootfsDirectoryForLxdRecover(mountPath: string): void {
  const rootfsPath = join(mountPath, "rootfs");
  if (directoryHasEntries(rootfsPath)) {
    return;
  }

  const stagingPath = join(mountPath, ".terrarium-rootfs.tmp");
  if (existsSync(stagingPath)) {
    throw new Error(`temporary LXD rootfs staging path already exists: ${stagingPath}`);
  }

  mkdirSync(stagingPath);
  for (const entry of readdirSync(mountPath)) {
    if (entry === "backup.yaml" || entry === "rootfs" || entry === ".terrarium-rootfs.tmp") {
      continue;
    }
    renameSync(join(mountPath, entry), join(stagingPath, entry));
  }
  if (!existsSync(rootfsPath)) {
    renameSync(stagingPath, rootfsPath);
  } else {
    for (const entry of readdirSync(stagingPath)) {
      renameSync(join(stagingPath, entry), join(rootfsPath, entry));
    }
    rmSync(stagingPath, { recursive: true, force: true });
  }

  if (!directoryHasEntries(rootfsPath)) {
    throw new Error(`recovered LXD dataset is missing rootfs contents at ${rootfsPath}`);
  }
}

async function prepareDatasetForLxdRecover(pool: string, targetDataset: string, oldName: string, newName: string): Promise<string> {
  const mountPath = join(lxdStorageRoot(pool), "containers", newName);
  const rootfsPath = join(mountPath, "rootfs");
  const rootfsDataset = `${targetDataset}/rootfs`;
  await runText(["mkdir", "-p", mountPath], PREFIX);
  await runAllowFailure(["zfs", "unmount", targetDataset]);
  await runText(["zfs", "set", `mountpoint=${mountPath}`, targetDataset], PREFIX);
  const mount = await runAllowFailure(["zfs", "mount", targetDataset]);
  if (mount.exitCode !== 0 && !`${mount.stderr}\n${mount.stdout}`.toLowerCase().includes("already mounted")) {
    throw new Error(`failed to mount recovered dataset at ${mountPath}: ${mount.stderr.trim() || mount.stdout.trim()}`);
  }
  if ((await zfsDatasetExists(rootfsDataset))) {
    await materializeRootfsDataset(rootfsDataset, rootfsPath);
  }
  rewriteBackupYaml(mountPath, oldName, newName);
  prepareRootfsDirectoryForLxdRecover(mountPath);
  return mountPath;
}

async function mountRecoveredDataset(targetDataset: string, mountPath: string): Promise<void> {
  const rootfsPath = join(mountPath, "rootfs");
  await runText(["mkdir", "-p", mountPath], PREFIX);
  await runText(["zfs", "set", `mountpoint=${mountPath}`, targetDataset], PREFIX);
  const mount = await runAllowFailure(["zfs", "mount", targetDataset]);
  if (mount.exitCode !== 0 && !`${mount.stderr}\n${mount.stdout}`.toLowerCase().includes("already mounted")) {
    throw new Error(`failed to remount recovered dataset at ${mountPath}: ${mount.stderr.trim() || mount.stdout.trim()}`);
  }

  if (!directoryHasEntries(rootfsPath)) {
    const datasetState = await runAllowFailure(["zfs", "get", "-H", "-o", "property,value", "mounted,mountpoint,canmount", targetDataset]);
    throw new Error(
      [
        `recovered LXD dataset is mounted but missing rootfs contents at ${rootfsPath}`,
        datasetState.stdout.trim() ? `zfs state:\n${datasetState.stdout.trim()}` : "",
        datasetState.stderr.trim() ? `zfs stderr:\n${datasetState.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
}

async function zfsDatasetExists(dataset: string): Promise<boolean> {
  return (await runAllowFailure(["zfs", "list", "-H", dataset])).exitCode === 0;
}

async function zfsSnapshotExists(snapshot: string): Promise<boolean> {
  return (await runAllowFailure(["zfs", "list", "-H", "-t", "snapshot", snapshot])).exitCode === 0;
}

function restoreTempDatasetName(targetDataset: string, label: string): string {
  const suffix = `${label}-${process.pid}-${Date.now()}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
  return `${targetDataset}-${suffix}`;
}

async function makeTempMountPath(): Promise<string> {
  return (await runText(["mktemp", "-d", "/var/tmp/terrarium-rootfs.XXXXXX"], PREFIX)).trim();
}

async function copyMountedRootfs(sourceMountPath: string, rootfsPath: string): Promise<void> {
  await runText(["mkdir", "-p", rootfsPath], PREFIX);
  await runText(["rsync", "-aHAX", "--numeric-ids", `${sourceMountPath}/`, `${rootfsPath}/`], PREFIX);
}

async function materializeRootfsDataset(rootfsDataset: string, rootfsPath: string): Promise<void> {
  const tempMountPath = await makeTempMountPath();
  try {
    await runAllowFailure(["zfs", "unmount", rootfsDataset]);
    await runText(["zfs", "set", `mountpoint=${tempMountPath}`, rootfsDataset], PREFIX);
    const rootfsMount = await runAllowFailure(["zfs", "mount", rootfsDataset]);
    if (rootfsMount.exitCode !== 0 && !`${rootfsMount.stderr}\n${rootfsMount.stdout}`.toLowerCase().includes("already mounted")) {
      throw new Error(`failed to mount recovered rootfs dataset at ${tempMountPath}: ${rootfsMount.stderr.trim() || rootfsMount.stdout.trim()}`);
    }
    await copyMountedRootfs(tempMountPath, rootfsPath);
  } finally {
    await runAllowFailure(["zfs", "unmount", rootfsDataset]);
    await runAllowFailure(["zfs", "destroy", "-r", rootfsDataset]);
    await runAllowFailure(["rm", "-rf", tempMountPath]);
  }
}

async function materializeRootfsSnapshotIfPresent(
  sourceDataset: string,
  snapshot: string,
  targetDataset: string,
  targetMountPath: string
): Promise<void> {
  const snapshotMarker = snapshot.indexOf("@");
  if (snapshotMarker === -1) {
    throw new Error(`invalid ZFS snapshot name: ${snapshot}`);
  }

  const childSnapshot = `${sourceDataset}/rootfs${snapshot.slice(snapshotMarker)}`;
  if (!(await zfsSnapshotExists(childSnapshot))) {
    return;
  }

  const tempDataset = restoreTempDatasetName(targetDataset, "rootfs-stage");
  const tempMountPath = await makeTempMountPath();
  const rootfsPath = join(targetMountPath, "rootfs");
  try {
    await runText(["zfs", "clone", "-o", `mountpoint=${tempMountPath}`, childSnapshot, tempDataset], PREFIX);
    await copyMountedRootfs(tempMountPath, rootfsPath);
    console.log(success(`Materialized rootfs from ${childSnapshot} into ${rootfsPath}`));
  } finally {
    await runAllowFailure(["zfs", "unmount", tempDataset]);
    await runAllowFailure(["zfs", "destroy", "-r", tempDataset]);
    await runAllowFailure(["rm", "-rf", tempMountPath]);
  }
}

async function recoverAsNewInstance(pool: string, sourceName: string, targetDataset: string, newName: string): Promise<void> {
  const mountPath = await prepareDatasetForLxdRecover(pool, targetDataset, sourceName, newName);
  console.log(`${label("Prepared mount:")} ${value(mountPath)}`);
  printAsNewRecoveryNotice(pool, targetDataset, newName);
  await handOffToLxdRecover();
  await mountRecoveredDataset(targetDataset, mountPath);
  const imported = await runAllowFailure(["lxc", "info", newName]);
  if (imported.exitCode !== 0) {
    const volumes = await runAllowFailure(["lxc", "storage", "volume", "list", pool]);
    const datasets = await runAllowFailure(["zfs", "list", "-H", "-o", "name,mountpoint", targetDataset]);
    throw new Error(
      [
        `LXD recovery completed but instance '${newName}' was not imported.`,
        volumes.stdout.trim() ? `storage volumes:\n${volumes.stdout.trim()}` : "",
        datasets.stdout.trim() ? `dataset:\n${datasets.stdout.trim()}` : "",
        imported.stderr.trim() ? `lxc info stderr:\n${imported.stderr.trim()}` : ""
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }
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
    await stopInstanceForRestore(instance);
    await runText(["zfs", "rollback", "-r", snapshot], PREFIX);
    console.log(success(`Rolled back ${instance} to ${snapshot}`));
    console.log(`${label("Next:")} ${value(`lxc start ${instance}`)}`);
    return;
  }

  if (!newName) {
    throw new Error("--as-new requires a target name");
  }

  const targetDataset = `${pool}/containers/${newName}`;
  await assertNewRestoreTargetIsUnused(newName, targetDataset);
  const targetMountPath = join(lxdStorageRoot(pool), "containers", newName);
  await runText(["mkdir", "-p", targetMountPath], PREFIX);
  await runText(["zfs", "clone", "-o", `mountpoint=${targetMountPath}`, snapshot, targetDataset], PREFIX);
  await materializeRootfsSnapshotIfPresent(dataset, snapshot, targetDataset, targetMountPath);
  console.log(success(`Cloned ${snapshot} to ${targetDataset}`));
  await recoverAsNewInstance(pool, instance, targetDataset, newName);
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
    await stopInstanceForRestore(instance);
  } else if (!newName) {
    throw new Error("--as-new requires a target name");
  }

  if (mode === "as-new") {
    await assertNewRestoreTargetIsUnused(newName, target);
  }

  await reconstructFromS3(instance, at, target);
  if (mode === "in-place") {
    console.log(success(`Reconstructed dataset for ${instance} into ${target}`));
    console.log(`${label("Next:")} ${value(`lxc start ${instance}`)}`);
  } else {
    console.log(success(`Reconstructed dataset into ${target}`));
    await recoverAsNewInstance(pool, instance, target, newName);
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
