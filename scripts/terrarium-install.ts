import { $ } from "bun";
import { confirm, input, select } from "@inquirer/prompts";
import type { CAC } from "cac";
import chalk from "chalk";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";

const PREFIX = "terrariumctl install";
const REPO_URL = process.env.TERRARIUM_REPO_URL ?? "https://github.com/terion-name/terrarium.git";
const REPO_DIR = process.env.TERRARIUM_REPO_DIR ?? "/opt/terrarium";
const BUNDLE_DIR = process.env.TERRARIUM_BUNDLE_DIR ?? "";

$.throws(true);

type InstallMode = "interactive" | "non-interactive";
type IdpMode = "none" | "zitadel_self_hosted";
type StorageMode = "disk" | "partition" | "loop";

type InstallOptions = {
  ref: string;
  mode: InstallMode;
  assumeYes: boolean;
  publicIp: string;
  email: string;
  domain: string;
  manageDomain: string;
  lxdDomain: string;
  idpMode: IdpMode;
  authDomain: string;
  zitadelAdminEmail: string;
  storageMode: string;
  storageSource: string;
  storageSize: string;
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

function info(message: string): void {
  console.log(chalk.cyan(`${PREFIX}: ${message}`));
}

function success(message: string): void {
  console.log(chalk.green(`${PREFIX}: ${message}`));
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
  } else if (existsSync(join(REPO_DIR, "ansible", "site.yml"))) {
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

async function listCandidateDisks(): Promise<Array<{ path: string; size: string }>> {
  const rootSource = await $`findmnt -n -o SOURCE /`.nothrow().quiet();
  const rootValue = rootSource.stdout.toString().trim();
  const rootDisk = rootValue ? (await $`lsblk -no PKNAME ${rootValue}`.nothrow().quiet()).stdout.toString().trim() : "";
  const rootPath = rootDisk ? `/dev/${rootDisk}` : "";
  const lsblk = (await $`lsblk -dpno NAME,TYPE,SIZE,MOUNTPOINT`.text()).trim();

  return lsblk
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts[1] === "disk" && parts[0] !== rootPath)
    .map((parts) => ({ path: parts[0] ?? "", size: parts[2] ?? "" }))
    .filter((item) => item.path);
}

async function promptText(message: string, defaultValue = ""): Promise<string> {
  return await input({
    message,
    default: defaultValue
  });
}

async function promptConfirm(message: string, defaultValue: boolean, assumeYes: boolean): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  return await confirm({ message, default: defaultValue });
}

async function interactiveConfig(options: InstallOptions): Promise<void> {
  options.publicIp = await detectPublicIp(options.publicIp);
  const dashed = dashedIp(options.publicIp);

  options.email = options.email || (await promptText("Email for ACME/notifications", `admin@${options.publicIp}.nip.io`));
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
      message: "Identity provider",
      choices: [
        { name: "none", value: "none" },
        { name: "zitadel-self-hosted", value: "zitadel_self_hosted" }
      ]
    })) as IdpMode;
  }

  if (options.idpMode === "zitadel_self_hosted") {
    options.authDomain =
      options.authDomain ||
      (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    options.authDomain = await promptText("ZITADEL auth domain", options.authDomain);
    options.zitadelAdminEmail = await promptText("ZITADEL bootstrap admin email", options.zitadelAdminEmail || options.email);
  } else {
    options.idpMode = "none";
    options.authDomain = "";
  }

  const disks = await listCandidateDisks();
  if (disks.length > 0) {
    for (const disk of disks) {
      info(`detected extra disk: ${disk.path} ${disk.size}`.trim());
    }
    if (!options.storageMode) {
      options.storageMode = (await select({
        message: "Choose storage mode",
        choices: [
          { name: "disk", value: "disk" },
          { name: "partition", value: "partition" },
          { name: "loop", value: "loop" }
        ]
      })) as StorageMode;
    }
  } else {
    info("No extra block volume detected.");
    info("Recommended production setup: attach block storage to the VPS and re-run Terrarium.");
    info("Falling back to loop mode keeps everything on the root filesystem.");
    options.storageMode = options.storageMode || "loop";
  }

  switch (options.storageMode) {
    case "disk":
    case "partition":
      if (!options.storageSource) {
        options.storageSource = await promptText("Storage source device or partition", disks[0]?.path ?? "");
      }
      if (!options.storageSource) {
        fail(`storage source is required for ${options.storageMode}`);
      }
      break;
    case "loop":
      options.storageSize = options.storageSize || (await promptText("Loop-backed ZFS pool size", "64G"));
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
    options.idpMode = "none";
  }
  if (options.idpMode !== "none" && options.idpMode !== "zitadel_self_hosted") {
    fail(`invalid --idp-mode value: ${options.idpMode}`);
  }
  const dashed = dashedIp(options.publicIp);
  options.manageDomain = options.manageDomain || (options.domain ? `manage.${options.domain}` : `manage.${dashed}.traefik.me`);
  options.lxdDomain = options.lxdDomain || (options.domain ? `lxd.${options.domain}` : `lxd.${dashed}.traefik.me`);

  if (!options.email) {
    fail("--email is required in non-interactive mode");
  }

  if (options.idpMode === "zitadel_self_hosted") {
    options.authDomain = options.authDomain || (options.domain ? `auth.${options.domain}` : `auth.${dashed}.traefik.me`);
    options.zitadelAdminEmail = options.zitadelAdminEmail || options.email;
  } else {
    options.authDomain = "";
  }

  if (!options.storageMode) {
    throw new Error("storage mode must be resolved after public IP detection");
  }

  switch (options.storageMode) {
    case "disk":
    case "partition":
      if (!options.storageSource) {
        fail(`--storage-source is required for ${options.storageMode}`);
      }
      break;
    case "loop":
      options.storageSize = options.storageSize || "64G";
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
  if (!options.storageMode) {
    if (disks.length > 0) {
      options.storageMode = "disk";
      options.storageSource = disks[0]?.path ?? "";
    } else {
      options.storageMode = "loop";
      options.storageSize = options.storageSize || "64G";
    }
  }
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
        !(await promptConfirm(`Terrarium may repartition ${options.storageSource}. Continue?`, false, options.assumeYes))
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
    terrarium_manage_domain: options.manageDomain,
    terrarium_lxd_domain: options.lxdDomain,
    terrarium_idp_mode: options.idpMode,
    terrarium_auth_domain: options.authDomain,
    terrarium_zitadel_admin_email: options.zitadelAdminEmail,
    terrarium_storage_mode: options.storageMode,
    terrarium_storage_source: options.storageSource,
    terrarium_storage_size: options.storageSize,
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
    (options.idpMode === "zitadel_self_hosted" && options.authDomain !== defaultAuth)
  ) {
    info("DNS records to create if you are using custom domains:");
    info(`  A ${options.manageDomain} -> ${options.publicIp}`);
    info(`  A ${options.lxdDomain} -> ${options.publicIp}`);
    if (options.idpMode === "zitadel_self_hosted") {
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
    domain: "",
    manageDomain: "",
    lxdDomain: "",
    idpMode: "none",
    authDomain: "",
    zitadelAdminEmail: "",
    storageMode: "",
    storageSource: "",
    storageSize: "",
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

async function installTerrarium(options: InstallOptions): Promise<void> {
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
  if (options.idpMode === "zitadel_self_hosted") {
    console.log(`${chalk.cyan("ZITADEL:")} ${chalk.white(`https://${options.authDomain}`)}`);
    console.log(`${chalk.cyan("ZITADEL bootstrap password:")} ${chalk.white("/etc/terrarium/secrets/zitadel_admin_password")}`);
  }
  console.log(`${chalk.cyan("Resolved config:")} ${chalk.white("/etc/terrarium/config.yaml")}`);
}

export function registerInstallCommand(cli: CAC): void {
  cli
    .command("install", "Install Terrarium on the current host")
    .option("--interactive", "Run with interactive prompts")
    .option("--non-interactive", "Require full configuration through flags")
    .option("--yes", "Assume yes for confirmation prompts")
    .option("--ref <ref>", "Git branch or tag to checkout for the Terrarium repo")
    .option("--email <email>", "ACME/notification email")
    .option("--domain <domain>", "Root domain used to derive service subdomains")
    .option("--manage-domain <domain>", "Cockpit domain")
    .option("--lxd-domain <domain>", "LXD domain")
    .option("--idp-mode <mode>", "Identity provider mode: none or zitadel-self-hosted")
    .option("--auth-domain <domain>", "ZITADEL auth domain")
    .option("--zitadel-admin-email <email>", "Bootstrap admin email for self-hosted ZITADEL")
    .option("--storage-mode <mode>", "Storage mode: disk, partition, or loop")
    .option("--storage-source <path>", "Disk or partition path for disk/partition mode")
    .option("--storage-size <size>", "Loop-backed pool size")
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
      const options = defaultOptions();
      options.ref = (rawOptions.ref as string | undefined) || options.ref;
      options.mode = rawOptions.nonInteractive ? "non-interactive" : "interactive";
      if (rawOptions.interactive) {
        options.mode = "interactive";
      }
      options.assumeYes = Boolean(rawOptions.yes);
      options.email = (rawOptions.email as string | undefined) ?? "";
      options.domain = (rawOptions.domain as string | undefined) ?? "";
      options.manageDomain = (rawOptions.manageDomain as string | undefined) ?? "";
      options.lxdDomain = (rawOptions.lxdDomain as string | undefined) ?? "";
      const idpMode = ((rawOptions.idpMode as string | undefined) ?? "none").replaceAll("-", "_");
      options.idpMode = (idpMode === "zitadel_self_hosted" ? "zitadel_self_hosted" : "none") as IdpMode;
      options.authDomain = (rawOptions.authDomain as string | undefined) ?? "";
      options.zitadelAdminEmail = (rawOptions.zitadelAdminEmail as string | undefined) ?? "";
      options.storageMode = (rawOptions.storageMode as string | undefined) ?? "";
      options.storageSource = (rawOptions.storageSource as string | undefined) ?? "";
      options.storageSize = (rawOptions.storageSize as string | undefined) ?? "";
      options.enableS3 = Boolean(rawOptions.enableS3);
      options.s3Endpoint = (rawOptions.s3Endpoint as string | undefined) ?? "";
      options.s3Bucket = (rawOptions.s3Bucket as string | undefined) ?? "";
      options.s3Region = (rawOptions.s3Region as string | undefined) ?? "";
      options.s3Prefix = (rawOptions.s3Prefix as string | undefined) ?? options.s3Prefix;
      options.s3AccessKey = (rawOptions.s3AccessKey as string | undefined) ?? "";
      options.s3SecretKey = (rawOptions.s3SecretKey as string | undefined) ?? "";
      options.enableSyncoid = Boolean(rawOptions.enableSyncoid);
      options.syncoidTarget = (rawOptions.syncoidTarget as string | undefined) ?? "";
      options.syncoidTargetDataset = (rawOptions.syncoidTargetDataset as string | undefined) ?? "";
      options.syncoidSshKey = (rawOptions.syncoidSshKey as string | undefined) ?? "";
      await installTerrarium(options);
    });
}
