import { $ } from "bun";
import { confirm, input, select } from "@inquirer/prompts";
import type { CAC } from "cac";
import chalk from "chalk";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { TERRARIUM_SPLASH, TERRARIUM_VERSION } from "./generated/build-info";

const PREFIX = "terrariumctl install";
const REPO_URL = process.env.TERRARIUM_REPO_URL ?? "https://github.com/terion-name/terrarium.git";
const REPO_DIR = process.env.TERRARIUM_REPO_DIR ?? "/opt/terrarium";
const BUNDLE_DIR = process.env.TERRARIUM_BUNDLE_DIR ?? "";

$.throws(true);

type InstallMode = "interactive" | "non-interactive";
type IdpMode = "local" | "oidc";
type StorageMode = "disk" | "partition" | "file";

type DiskCandidate = {
  path: string;
  sizeBytes: number;
  sizeLabel: string;
};

type PartitionCandidate =
  | {
      kind: "partition";
      source: string;
      sizeBytes: number;
      sizeLabel: string;
      description: string;
    }
  | {
      kind: "free-space";
      source: string;
      sizeBytes: number;
      sizeLabel: string;
      description: string;
      startMiB: string;
      endMiB: string;
    };

type InstallOptions = {
  ref: string;
  mode: InstallMode;
  assumeYes: boolean;
  publicIp: string;
  email: string;
  acmeEmail: string;
  domain: string;
  manageDomain: string;
  lxdDomain: string;
  idpMode: IdpMode | "";
  authDomain: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  zitadelAdminEmail: string;
  storageMode: string;
  storageSource: string;
  storageSize: string;
  storagePartitionStart: string;
  storagePartitionEnd: string;
  enableS3: boolean;
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3Prefix: string;
  s3AccessKey: string;
  s3SecretKey: string;
  enableSyncoid: boolean;
  syncoidTarget: string;
  syncoidTargetDataset: string;
  syncoidSshKey: string;
};

function fail(message: string): never {
  console.error(chalk.red(`${PREFIX}: ${message}`));
  process.exit(1);
}

const RESERVED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

function info(message: string): void {
  console.log(chalk.cyan(`${PREFIX}: ${message}`));
}

function success(message: string): void {
  console.log(chalk.green(`${PREFIX}: ${message}`));
}

function printSplash(): void {
  console.log(chalk.magenta(TERRARIUM_SPLASH));
  console.log(chalk.dim(`terrariumctl install ${TERRARIUM_VERSION}`));
  console.log("");
}

export function validateEmail(email: string, fieldName: string): string {
  const normalized = email.trim();
  const match = normalized.match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) {
    fail(`${fieldName} must be a valid email address`);
  }
  const domain = match[1].toLowerCase();
  if (RESERVED_EMAIL_DOMAINS.has(domain)) {
    fail(`${fieldName} must not use reserved example.* domains because ACME rejects them`);
  }
  return normalized;
}

export function normalizeOidcIssuer(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    fail(`${fieldName} must not be empty`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    fail(`${fieldName} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    fail(`${fieldName} must use http or https`);
  }
  if (parsed.pathname === "/") {
    parsed.pathname = "";
  }
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function requireRoot(): void {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    fail("run as root");
  }
}

function parseOsRelease(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync("/etc/os-release", "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    values[key] = rawValue.replace(/^"/, "").replace(/"$/, "");
  }
  return values;
}

function ensureOs(): void {
  const os = parseOsRelease();
  if (os.ID !== "ubuntu") {
    fail("Ubuntu is required");
  }
  if (os.VERSION_ID !== "24.04") {
    fail("Ubuntu 24.04 is required");
  }
}

async function ensureDeps(): Promise<void> {
  await $`apt-get update -y`;
  await $`apt-get install -y ca-certificates curl git ansible python3 jq unzip`;
}

function syncBundleArtifacts(bundleDir: string, repoDir: string): void {
  if (!bundleDir) {
    return;
  }
  const sourceDir = existsSync(join(bundleDir, "dist")) ? join(bundleDir, "dist") : bundleDir;
  mkdirSync(join(repoDir, "dist"), { recursive: true });
  cpSync(sourceDir, join(repoDir, "dist"), { recursive: true, force: true });
}

function stageRunningBinary(repoDir: string): void {
  if (!process.execPath || !existsSync(process.execPath)) {
    return;
  }
  const targetDir = join(repoDir, "dist");
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(process.execPath, join(targetDir, "terrariumctl"));
}

function localSourcePath(repoUrl: string): string {
  if (repoUrl.startsWith("file://")) {
    return repoUrl.slice("file://".length);
  }
  if (repoUrl.startsWith("/")) {
    return repoUrl;
  }
  return "";
}

function syncLocalSourceRepo(sourcePath: string, repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(repoDir, { recursive: true });
  cpSync(sourcePath, repoDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = source.split("/").at(-1) ?? "";
      return ![".git", "node_modules", "dist"].includes(base);
    }
  });
}

async function prepareRepo(ref: string): Promise<void> {
  const sourcePath = localSourcePath(REPO_URL);
  if (sourcePath && existsSync(join(sourcePath, "ansible", "site.yml"))) {
    info(`syncing local Terrarium source from ${sourcePath}`);
    syncLocalSourceRepo(sourcePath, REPO_DIR);
  } else if (existsSync(join(REPO_DIR, ".git"))) {
    info(`updating existing checkout in ${REPO_DIR}`);
    await $`git -C ${REPO_DIR} fetch --tags origin`;
    await $`git -C ${REPO_DIR} checkout ${ref}`;
    await $`git -C ${REPO_DIR} pull --ff-only origin ${ref}`.nothrow().quiet();
  } else {
    rmSync(REPO_DIR, { recursive: true, force: true });
    await $`git clone --depth 1 --branch ${ref} ${REPO_URL} ${REPO_DIR}`;
  }

  syncBundleArtifacts(BUNDLE_DIR, REPO_DIR);
  if (!existsSync(join(REPO_DIR, "dist", "terrariumctl"))) {
    stageRunningBinary(REPO_DIR);
  }
  if (!existsSync(join(REPO_DIR, "dist", "terrariumctl"))) {
    fail("compiled Terrarium binaries are missing from the repository checkout");
  }

  await $`cd ${REPO_DIR}; ansible-galaxy collection install -r requirements.yml`;
}

function dashedIp(ip: string): string {
  return ip.replaceAll(".", "-");
}

async function detectPublicIp(current = ""): Promise<string> {
  if (current) {
    return current;
  }
  const direct = await $`curl -4fsSL https://api.ipify.org`.nothrow().quiet();
  const directValue = direct.stdout.toString().trim();
  if (direct.exitCode === 0 && directValue) {
    return directValue;
  }
  const fallback = (await $`hostname -I`.text()).trim();
  const first = fallback.split(/\s+/).find(Boolean) ?? "";
  if (!first) {
    fail("failed to detect public IP");
  }
  return first;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }
  const units = ["B", "K", "M", "G", "T", "P"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

async function detectRootDiskPath(): Promise<string> {
  const rootSource = await $`findmnt -n -o SOURCE /`.nothrow().quiet();
  const rootValue = rootSource.stdout.toString().trim();
  const rootDisk = rootValue ? (await $`lsblk -no PKNAME ${rootValue}`.nothrow().quiet()).stdout.toString().trim() : "";
  return rootDisk ? `/dev/${rootDisk}` : "";
}

async function listCandidateDisks(): Promise<DiskCandidate[]> {
  const rootPath = await detectRootDiskPath();
  const lsblk = (await $`lsblk -dpno NAME,TYPE,SIZE,MOUNTPOINT`.text()).trim();
  const diskRows = lsblk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === "disk" && parts[0] !== rootPath)
    .map((parts) => ({ path: parts[0] ?? "", sizeLabel: parts[2] ?? "" }))
    .filter((item) => item.path);

  const result: DiskCandidate[] = [];
  for (const row of diskRows) {
    const sizeBytes = Number((await $`lsblk -dbno SIZE ${row.path}`.text()).trim() || "0");
    result.push({ path: row.path, sizeBytes, sizeLabel: row.sizeLabel || formatBytes(sizeBytes) });
  }
  return result;
}

async function listPartitionCandidates(disks: DiskCandidate[]): Promise<PartitionCandidate[]> {
  const candidates: PartitionCandidate[] = [];

  for (const disk of disks) {
    const partsRaw = (await $`lsblk -rnbpo NAME,TYPE,SIZE,MOUNTPOINT ${disk.path}`.text()).trim();
    if (partsRaw) {
      for (const line of partsRaw.split("\n")) {
        const [path = "", type = "", sizeRaw = "0", ...rest] = line.trim().split(/\s+/);
        const mountpoint = rest.join(" ");
        if (type !== "part" || !path || mountpoint) {
          continue;
        }
        const sizeBytes = Number(sizeRaw) || 0;
        candidates.push({
          kind: "partition",
          source: path,
          sizeBytes,
          sizeLabel: formatBytes(sizeBytes),
          description: `${path} existing partition (${formatBytes(sizeBytes)})`
        });
      }
    }

    const parted = await $`parted -sm ${disk.path} unit MiB print free`.nothrow().quiet();
    if (parted.exitCode !== 0) {
      continue;
    }
    for (const line of parted.stdout.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes(":free;")) {
        continue;
      }
      const fields = trimmed.split(":");
      if (fields.length < 5) {
        continue;
      }
      const startField = fields[1]?.replace("MiB", "") ?? "";
      const endField = fields[2]?.replace("MiB", "") ?? "";
      const sizeField = fields[3]?.replace("MiB", "") ?? "";
      const startMiB = Number(startField);
      const endMiB = Number(endField);
      const sizeMiB = Number(sizeField);
      if (!Number.isFinite(startMiB) || !Number.isFinite(endMiB) || !Number.isFinite(sizeMiB) || sizeMiB < 256) {
        continue;
      }
      candidates.push({
        kind: "free-space",
        source: disk.path,
        sizeBytes: Math.round(sizeMiB * 1024 * 1024),
        sizeLabel: `${sizeMiB >= 1024 ? `${(sizeMiB / 1024).toFixed(sizeMiB / 1024 >= 10 ? 0 : 1)}G` : `${Math.round(sizeMiB)}M`}`,
        description: `${disk.path} free space ${startField}-${endField}MiB (${formatBytes(Math.round(sizeMiB * 1024 * 1024))})`,
        startMiB: `${startField}MiB`,
        endMiB: `${endField}MiB`
      });
    }
  }

  return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes);
}

function selectLargestDisk(disks: DiskCandidate[]): DiskCandidate | null {
  return disks.sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
}

function selectLargestPartitionCandidate(candidates: PartitionCandidate[]): PartitionCandidate | null {
  return candidates.sort((left, right) => right.sizeBytes - left.sizeBytes)[0] ?? null;
}

async function promptText(message: string, defaultValue = ""): Promise<string> {
  return await input({
    message,
    default: defaultValue
  });
}

async function promptEmail(message: string, defaultValue = "", fieldName = "email"): Promise<string> {
  return await input({
    message,
    default: defaultValue,
    validate: (value) => {
      const normalized = value.trim();
      const match = normalized.match(/^[^@\s]+@([^@\s]+)$/);
      if (!match) {
        return "Enter a valid email address";
      }
      if (RESERVED_EMAIL_DOMAINS.has(match[1].toLowerCase())) {
        return "Reserved example.* domains are not accepted";
      }
      return true;
    }
  }).then((value) => validateEmail(value, fieldName));
}

async function promptConfirm(message: string, defaultValue: boolean, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  return await confirm({ message, default: defaultValue });
}

function applyPartitionCandidate(options: InstallOptions, candidate: PartitionCandidate): void {
  options.storageSource = candidate.source;
  if (candidate.kind === "free-space") {
    options.storagePartitionStart = candidate.startMiB;
    options.storagePartitionEnd = candidate.endMiB;
  } else {
    options.storagePartitionStart = "";
    options.storagePartitionEnd = "";
  }
}

async function resolveAutoStorageSource(options: InstallOptions, disks: DiskCandidate[], partitions: PartitionCandidate[]): Promise<void> {
  if (options.storageSource !== "auto") {
    return;
  }
  if (options.storageMode === "disk") {
    const disk = selectLargestDisk(disks);
    if (!disk) {
      fail("no allocatable non-root disk found for --storage-source=auto");
    }
    options.storageSource = disk.path;
    return;
  }
  if (options.storageMode === "partition") {
    const candidate = selectLargestPartitionCandidate(partitions);
    if (!candidate) {
      fail("no allocatable partition target found for --storage-source=auto");
    }
    applyPartitionCandidate(options, candidate);
  }
}

async function interactiveConfig(options: InstallOptions): Promise<void> {
  options.publicIp = await detectPublicIp(options.publicIp);
  const dashed = dashedIp(options.publicIp);

  options.email = options.email || (await promptEmail("Terrarium contact/admin email", `admin@${options.publicIp}.nip.io`, "--email"));
  options.acmeEmail = options.acmeEmail || (await promptEmail("ACME account email", options.email, "--acme-email"));
  options.zitadelAdminEmail = options.zitadelAdminEmail || options.email;

  if (!options.domain && !options.manageDomain) {
    options.manageDomain = `manage.${dashed}.traefik.me`;
  }
  if (!options.domain && !options.lxdDomain) {
    options.lxdDomain = `lxd.${dashed}.traefik.me`;
  }

  if (options.domain) {
    options.manageDomain = options.manageDomain || `manage.${options.domain}`;
    options.lxdDomain = options.lxdDomain || `lxd.${options.domain}`;
  } else {
    options.manageDomain = await promptText("Cockpit domain", options.manageDomain);
    options.lxdDomain = await promptText("LXD domain", options.lxdDomain);
  }

  if (!options.idpMode) {
    options.idpMode = (await select({
      message: "Identity provider mode",
      choices: [
        { name: "local", value: "local" },
        { name: "oidc", value: "oidc" }
      ]
    })) as IdpMode;
  }

  if (options.idpMode === "local") {
    options.authDomain =
      options.authDomain ||
      (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    options.authDomain = await promptText("ZITADEL auth domain", options.authDomain);
    options.oidcIssuer = normalizeOidcIssuer(`https://${options.authDomain}/`, "--oidc");
    options.zitadelAdminEmail = await promptEmail(
      "ZITADEL bootstrap admin email",
      options.zitadelAdminEmail || options.email,
      "--zitadel-admin-email"
    );
  } else {
    options.authDomain = "";
    options.oidcIssuer = normalizeOidcIssuer(
      options.oidcIssuer || (await promptText("External OIDC issuer URL", "")),
      "--oidc"
    );
    options.oidcClientId = options.oidcClientId || (await promptText("External OIDC client ID", ""));
    options.oidcClientSecret = options.oidcClientSecret || (await promptText("External OIDC client secret", ""));
    if (!options.oidcClientId) {
      fail("--oidc-client is required for external OIDC mode");
    }
    if (!options.oidcClientSecret) {
      fail("--oidc-secret is required for external OIDC mode");
    }
  }

  const disks = await listCandidateDisks();
  const partitionCandidates = await listPartitionCandidates(disks);
  if (disks.length > 0) {
    for (const disk of disks) {
      info(`detected extra disk: ${disk.path} ${disk.sizeLabel}`.trim());
    }
    if (!options.storageMode) {
      options.storageMode = (await select({
        message: "Choose storage mode",
        choices: [
          { name: "disk", value: "disk" },
          { name: "partition", value: "partition" },
          { name: "file", value: "file" }
        ]
      })) as StorageMode;
    }
  } else {
    info("No extra block volume detected.");
    info("Recommended production setup: attach block storage to the VPS and re-run Terrarium.");
    info("Falling back to file mode keeps everything on the root filesystem.");
    options.storageMode = options.storageMode || "file";
  }

  switch (options.storageMode) {
    case "disk": {
      await resolveAutoStorageSource(options, disks, partitionCandidates);
      if (!options.storageSource) {
        const suggested = selectLargestDisk(disks);
        if (!suggested) {
          fail("disk mode requires a non-root disk, but none were detected");
        }
        info(`Suggested disk target: ${suggested.path} (${suggested.sizeLabel})`);
        if (!(await promptConfirm(`Use ${suggested.path} for whole-disk ZFS storage?`, true, options.assumeYes))) {
          options.storageSource = await promptText("Storage source disk", suggested.path);
        } else {
          options.storageSource = suggested.path;
        }
      }
      if (!options.storageSource) {
        fail("storage source is required for disk mode");
      }
      break;
    }
    case "partition": {
      await resolveAutoStorageSource(options, disks, partitionCandidates);
      if (!options.storageSource) {
        const suggested = selectLargestPartitionCandidate(partitionCandidates);
        if (!suggested) {
          fail("partition mode requires allocatable free space or an unused partition, but none were found");
        }
        info(`Suggested partition target: ${suggested.description}`);
        if (!(await promptConfirm(`Use ${suggested.description}?`, true, options.assumeYes))) {
          const chosen = (await select({
            message: "Choose allocatable partition target",
            choices: partitionCandidates.map((candidate) => ({
              name: candidate.description,
              value: JSON.stringify(candidate)
            }))
          })) as string;
          applyPartitionCandidate(options, JSON.parse(chosen) as PartitionCandidate);
        } else {
          applyPartitionCandidate(options, suggested);
        }
      }
      if (!options.storageSource) {
        fail("storage source is required for partition mode");
      }
      break;
    }
    case "file":
      options.storageSize = options.storageSize || (await promptText("File-backed ZFS pool size", "64G"));
      options.storagePartitionStart = "";
      options.storagePartitionEnd = "";
      break;
    default:
      fail(`unsupported storage mode: ${options.storageMode}`);
  }

  if (await promptConfirm("Configure S3 archive backups?", false, options.assumeYes)) {
    options.enableS3 = true;
    options.s3Endpoint = options.s3Endpoint || (await promptText("S3 endpoint", "https://s3.amazonaws.com"));
    options.s3Bucket = options.s3Bucket || (await promptText("S3 bucket", ""));
    options.s3Region = options.s3Region || (await promptText("S3 region", "us-east-1"));
    options.s3Prefix = options.s3Prefix || (await promptText("S3 prefix", "terrarium"));
    options.s3AccessKey = options.s3AccessKey || (await promptText("S3 access key", ""));
    options.s3SecretKey = options.s3SecretKey || (await promptText("S3 secret key", ""));
  }

  if (await promptConfirm("Configure syncoid replication to another ZFS host?", false, options.assumeYes)) {
    options.enableSyncoid = true;
    options.syncoidTarget = options.syncoidTarget || (await promptText("syncoid SSH target (user@host)", ""));
    options.syncoidTargetDataset = options.syncoidTargetDataset || (await promptText("Remote dataset", "backup/terrarium"));
    options.syncoidSshKey = options.syncoidSshKey || (await promptText("SSH private key path", "/root/.ssh/id_ed25519"));
  }
}

function validateNonInteractive(options: InstallOptions): void {
  if (!options.idpMode) {
    fail("--idp must be either local or oidc");
  }
  if (!["local", "oidc"].includes(options.idpMode)) {
    fail(`invalid --idp value: ${options.idpMode}`);
  }
  const dashed = dashedIp(options.publicIp);
  options.manageDomain = options.manageDomain || (options.domain ? `manage.${options.domain}` : `manage.${dashed}.traefik.me`);
  options.lxdDomain = options.lxdDomain || (options.domain ? `lxd.${options.domain}` : `lxd.${dashed}.traefik.me`);

  if (!options.email) {
    fail("--email is required in non-interactive mode");
  }
  options.email = validateEmail(options.email, "--email");
  options.acmeEmail = validateEmail(options.acmeEmail || options.email, "--acme-email");

  if (options.idpMode === "local") {
    options.authDomain = options.authDomain || (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    options.oidcIssuer = normalizeOidcIssuer(`https://${options.authDomain}/`, "--oidc");
    options.zitadelAdminEmail = options.zitadelAdminEmail || options.email;
    options.zitadelAdminEmail = validateEmail(options.zitadelAdminEmail, "--zitadel-admin-email");
    options.oidcClientId = "";
    options.oidcClientSecret = "";
  } else {
    options.authDomain = "";
    if (!options.oidcIssuer) {
      fail("--oidc is required when --idp=oidc");
    }
    options.oidcIssuer = normalizeOidcIssuer(options.oidcIssuer, "--oidc");
    if (!options.oidcClientId) {
      fail("--oidc-client is required when --idp=oidc");
    }
    if (!options.oidcClientSecret) {
      fail("--oidc-secret is required when --idp=oidc");
    }
  }

  if (!options.storageMode) {
    fail("--storage-mode is required in non-interactive mode");
  }

  switch (options.storageMode) {
    case "disk":
    case "partition":
      if (!options.storageSource) {
        fail(`--storage-source is required for ${options.storageMode}`);
      }
      if (options.storageSource === "auto") {
        fail(`--storage-source=auto must be resolved before validation for ${options.storageMode}`);
      }
      break;
    case "file":
      options.storageSize = options.storageSize || "64G";
      options.storagePartitionStart = "";
      options.storagePartitionEnd = "";
      break;
    default:
      fail(`invalid --storage-mode value: ${options.storageMode}`);
  }

  if (options.enableS3) {
    if (!options.s3Bucket) {
      fail("--s3-bucket is required when S3 is enabled");
    }
    if (!options.s3AccessKey) {
      fail("--s3-access-key is required when S3 is enabled");
    }
    if (!options.s3SecretKey) {
      fail("--s3-secret-key is required when S3 is enabled");
    }
    options.s3Endpoint = options.s3Endpoint || "https://s3.amazonaws.com";
    options.s3Region = options.s3Region || "us-east-1";
  }

  if (options.enableSyncoid) {
    if (!options.syncoidTarget) {
      fail("--syncoid-target is required when syncoid is enabled");
    }
    if (!options.syncoidTargetDataset) {
      fail("--syncoid-target-dataset is required when syncoid is enabled");
    }
    options.syncoidSshKey = options.syncoidSshKey || "/root/.ssh/id_ed25519";
  }
}

async function resolveNonInteractiveStorage(options: InstallOptions): Promise<void> {
  const disks = await listCandidateDisks();
  const partitionCandidates = await listPartitionCandidates(disks);
  await resolveAutoStorageSource(options, disks, partitionCandidates);
}

async function confirmDestructiveActions(options: InstallOptions): Promise<void> {
  switch (options.storageMode) {
    case "disk":
      if (!(await promptConfirm(`Terrarium will WIPE ${options.storageSource}. Continue?`, false, options.assumeYes))) {
        fail("aborted");
      }
      break;
    case "partition":
      if (
        options.storageSource &&
        existsSync(options.storageSource) &&
        !(await promptConfirm(
          options.storagePartitionStart && options.storagePartitionEnd
            ? `Terrarium will create a partition on ${options.storageSource} in free space ${options.storagePartitionStart}-${options.storagePartitionEnd}. Continue?`
            : `Terrarium may repartition ${options.storageSource}. Continue?`,
          false,
          options.assumeYes
        ))
      ) {
        fail("aborted");
      }
      break;
  }
}

function buildConfig(options: InstallOptions): string {
  return stringify({
    terrarium_repo_dir: REPO_DIR,
    terrarium_public_ip: options.publicIp,
    terrarium_root_domain: options.domain,
    terrarium_email: options.email,
    terrarium_acme_email: options.acmeEmail,
    terrarium_manage_domain: options.manageDomain,
    terrarium_lxd_domain: options.lxdDomain,
    terrarium_idp_mode: options.idpMode,
    terrarium_auth_domain: options.authDomain,
    terrarium_oidc_issuer: options.oidcIssuer,
    terrarium_oidc_client_id: options.oidcClientId,
    terrarium_oidc_client_secret: options.oidcClientSecret,
    terrarium_zitadel_admin_email: options.zitadelAdminEmail,
    terrarium_storage_mode: options.storageMode,
    terrarium_storage_source: options.storageSource,
    terrarium_storage_size: options.storageSize,
    terrarium_storage_partition_start: options.storagePartitionStart,
    terrarium_storage_partition_end: options.storagePartitionEnd,
    terrarium_enable_s3: options.enableS3,
    terrarium_s3_endpoint: options.s3Endpoint,
    terrarium_s3_bucket: options.s3Bucket,
    terrarium_s3_region: options.s3Region,
    terrarium_s3_prefix: options.s3Prefix,
    terrarium_s3_access_key: options.s3AccessKey,
    terrarium_s3_secret_key: options.s3SecretKey,
    terrarium_enable_syncoid: options.enableSyncoid,
    terrarium_syncoid_target: options.syncoidTarget,
    terrarium_syncoid_target_dataset: options.syncoidTargetDataset,
    terrarium_syncoid_ssh_key: options.syncoidSshKey
  });
}

async function runPlaybook(configPath: string): Promise<void> {
  await $`cd ${REPO_DIR}; ansible-playbook -i ansible/inventory.ini ansible/site.yml -e @${configPath}`;
}

function printDnsGuidance(options: InstallOptions): void {
  const dashed = dashedIp(options.publicIp);
  const defaultManage = `manage.${dashed}.traefik.me`;
  const defaultLxd = `lxd.${dashed}.traefik.me`;
  const defaultAuth = `auth.${dashed}.traefik.me`;

  if (
    options.domain ||
    options.manageDomain !== defaultManage ||
    options.lxdDomain !== defaultLxd ||
    (options.idpMode === "local" && options.authDomain !== defaultAuth)
  ) {
    info("DNS records to create if you are using custom domains:");
    info(`  A ${options.manageDomain} -> ${options.publicIp}`);
    info(`  A ${options.lxdDomain} -> ${options.publicIp}`);
    if (options.idpMode === "local") {
      info(`  A ${options.authDomain} -> ${options.publicIp}`);
    }
  }
}

function defaultOptions(): InstallOptions {
  return {
    ref: "main",
    mode: "interactive",
    assumeYes: false,
    publicIp: "",
    email: "",
    acmeEmail: "",
    domain: "",
    manageDomain: "",
    lxdDomain: "",
    idpMode: "",
    authDomain: "",
    oidcIssuer: "",
    oidcClientId: "",
    oidcClientSecret: "",
    zitadelAdminEmail: "",
    storageMode: "",
    storageSource: "",
    storageSize: "",
    storagePartitionStart: "",
    storagePartitionEnd: "",
    enableS3: false,
    s3Endpoint: "",
    s3Bucket: "",
    s3Region: "",
    s3Prefix: "terrarium",
    s3AccessKey: "",
    s3SecretKey: "",
    enableSyncoid: false,
    syncoidTarget: "",
    syncoidTargetDataset: "",
    syncoidSshKey: ""
  };
}

function readCliOption(rawOptions: Record<string, unknown>, key: string, aliases: string[] = []): string {
  for (const candidate of [key, ...aliases]) {
    const value = rawOptions[candidate];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

async function installTerrarium(options: InstallOptions): Promise<void> {
  printSplash();
  requireRoot();
  ensureOs();
  await ensureDeps();
  await prepareRepo(options.ref);

  options.publicIp = await detectPublicIp(options.publicIp);
  if (options.mode === "interactive") {
    await interactiveConfig(options);
  } else {
    await resolveNonInteractiveStorage(options);
    validateNonInteractive(options);
  }

  await confirmDestructiveActions(options);

  const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-"));
  const configPath = join(tempDir, "config.yml");
  writeFileSync(configPath, buildConfig(options), "utf8");

  printDnsGuidance(options);
  await runPlaybook(configPath);

  success("Terrarium installation finished.");
  console.log(`${chalk.cyan("Cockpit:")} ${chalk.white(`https://${options.manageDomain}`)}`);
  console.log(`${chalk.cyan("LXD UI/API:")} ${chalk.white(`https://${options.lxdDomain}`)}`);
  if (options.idpMode === "local") {
    console.log(`${chalk.cyan("ZITADEL:")} ${chalk.white(`https://${options.authDomain}`)}`);
    console.log(`${chalk.cyan("ZITADEL bootstrap password:")} ${chalk.white("/etc/terrarium/secrets/zitadel_admin_password")}`);
  }
  console.log(`${chalk.cyan("OIDC issuer:")} ${chalk.white(options.oidcIssuer)}`);
  console.log(`${chalk.cyan("Resolved config:")} ${chalk.white("/etc/terrarium/config.yaml")}`);
}

export function registerInstallCommand(cli: CAC): void {
  cli
    .command("install", "Install Terrarium on the current host")
    .option("--non-interactive", "Disable prompts and require full configuration through flags")
    .option("--yes", "Assume yes for confirmation prompts")
    .option("--ref <ref>", "Git branch or tag to checkout for the Terrarium repo")
    .option("--email <email>", "Terrarium contact/admin email")
    .option("--acme-email <email>", "ACME account email for Traefik and LXD")
    .option("--domain <domain>", "Root domain used to derive service subdomains")
    .option("--manage-domain <domain>", "Cockpit domain")
    .option("--lxd-domain <domain>", "LXD domain")
    .option("--idp <mode>", "Identity provider mode: local or oidc")
    .option("--oidc <issuer>", "OIDC issuer URL; required when --idp=oidc")
    .option("--oidc-client <clientId>", "OIDC client ID; required when --idp=oidc")
    .option("--oidc-secret <clientSecret>", "OIDC client secret; required when --idp=oidc")
    .option("--auth-domain <domain>", "ZITADEL auth domain")
    .option("--zitadel-admin-email <email>", "Bootstrap admin email for self-hosted ZITADEL")
    .option("--storage-mode <mode>", "Storage mode: disk, partition, or file")
    .option("--storage-source <pathOrAuto>", "Disk or partition path for disk/partition mode, or auto")
    .option("--storage-size <size>", "File-backed pool size")
    .option("--enable-s3", "Enable S3 archive backups")
    .option("--s3-endpoint <url>", "S3 endpoint URL")
    .option("--s3-bucket <name>", "S3 bucket name")
    .option("--s3-region <name>", "S3 region")
    .option("--s3-prefix <prefix>", "S3 object prefix")
    .option("--s3-access-key <key>", "S3 access key")
    .option("--s3-secret-key <secret>", "S3 secret key")
    .option("--enable-syncoid", "Enable syncoid replication")
    .option("--syncoid-target <host>", "Remote syncoid SSH target")
    .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset")
    .option("--syncoid-ssh-key <path>", "SSH key path for syncoid")
    .action(async (rawOptions) => {
      const cliOptions = rawOptions as Record<string, unknown>;
      const options = defaultOptions();
      options.ref = readCliOption(cliOptions, "ref") || options.ref;
      options.mode = Boolean(cliOptions.nonInteractive) ? "non-interactive" : "interactive";
      options.assumeYes = Boolean(cliOptions.yes);
      options.email = readCliOption(cliOptions, "email");
      options.acmeEmail = readCliOption(cliOptions, "acmeEmail");
      options.domain = readCliOption(cliOptions, "domain");
      options.manageDomain = readCliOption(cliOptions, "manageDomain");
      options.lxdDomain = readCliOption(cliOptions, "lxdDomain");
      options.idpMode = readCliOption(cliOptions, "idp").trim().toLowerCase() as IdpMode | "";
      options.oidcIssuer = readCliOption(cliOptions, "oidc");
      options.oidcClientId = readCliOption(cliOptions, "oidcClient");
      options.oidcClientSecret = readCliOption(cliOptions, "oidcSecret");
      options.authDomain = readCliOption(cliOptions, "authDomain");
      options.zitadelAdminEmail = readCliOption(cliOptions, "zitadelAdminEmail");
      options.storageMode = readCliOption(cliOptions, "storageMode").replace("loop", "file");
      options.storageSource = readCliOption(cliOptions, "storageSource");
      options.storageSize = readCliOption(cliOptions, "storageSize");
      options.enableS3 = Boolean(cliOptions.enableS3);
      options.s3Endpoint = readCliOption(cliOptions, "s3Endpoint", ["s3-endpoint"]);
      options.s3Bucket = readCliOption(cliOptions, "s3Bucket", ["s3-bucket"]);
      options.s3Region = readCliOption(cliOptions, "s3Region", ["s3-region"]);
      options.s3Prefix = readCliOption(cliOptions, "s3Prefix", ["s3-prefix"]) || options.s3Prefix;
      options.s3AccessKey = readCliOption(cliOptions, "s3AccessKey", ["s3-accessKey", "s3-access-key"]);
      options.s3SecretKey = readCliOption(cliOptions, "s3SecretKey", ["s3-secretKey", "s3-secret-key"]);
      options.enableSyncoid = Boolean(cliOptions.enableSyncoid);
      options.syncoidTarget = readCliOption(cliOptions, "syncoidTarget");
      options.syncoidTargetDataset = readCliOption(cliOptions, "syncoidTargetDataset");
      options.syncoidSshKey = readCliOption(cliOptions, "syncoidSshKey");
      await installTerrarium(options);
    });
}
