import { confirm, input } from "@inquirer/prompts";
import { cac } from "cac";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { normalizeOidcIssuer, registerInstallCommand, validateEmail } from "./terrarium-install";
import { backupExportCmd } from "./terrarium-s3-export";
import { proxySyncCmd as syncProxyConfig } from "./terrarium-traefik-sync";
import { idpSyncCmd as syncIdpConfig } from "./terrarium-zitadel-sync";
import { reconstructFromS3 } from "./terrarium-zfs-reconstruct";
import { configBoolean, configString, loadConfig, runAllowFailure, runInteractive, runText } from "./lib/common";

const PREFIX = "terrariumctl";
const CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";

function normalizedArgv(rawArgv: string[]): string[] {
  if (rawArgv.length < 2) {
    return ["terrariumctl", "terrariumctl"];
  }
  const second = rawArgv[1] ?? "";
  const looksLikeScriptPath =
    second.includes("/") || second.endsWith(".ts") || second.endsWith(".js") || second.includes("terrariumctl");
  if (looksLikeScriptPath) {
    return rawArgv;
  }
  return [rawArgv[0] ?? "terrariumctl", "terrariumctl", ...rawArgv.slice(1)];
}

function heading(text: string): string {
  return chalk.bold(text);
}

function label(text: string): string {
  return chalk.cyan(text);
}

function value(text: string): string {
  return chalk.white(text);
}

function success(text: string): string {
  return chalk.green(text);
}

function requireConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`config not found: ${CONFIG_PATH}`);
  }
  return loadConfig(CONFIG_PATH, PREFIX);
}

function loadMutableConfig(): Record<string, unknown> {
  return parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function oidcIssuer(config: Record<string, unknown>): string {
  return configString(config, "terrarium_oidc_issuer");
}

function idpMode(config: Record<string, unknown>): string {
  return configString(config, "terrarium_idp_mode", "oidc");
}

function idpEnabled(config: Record<string, unknown>): boolean {
  return idpMode(config) === "local";
}

function defaultServiceDomain(rootDomain: string, publicIp: string, prefix: string): string {
  const dashed = publicIp.replaceAll(".", "-");
  return rootDomain ? `${prefix}.${rootDomain}` : `${prefix}.${dashed}.traefik.me`;
}

function setConfigValue(config: Record<string, unknown>, key: string, value: unknown): void {
  config[key] = value;
}

function cliOption(options: Record<string, unknown>, key: string, aliases: string[] = []): string | undefined {
  for (const candidate of [key, ...aliases]) {
    const value = options[candidate];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

async function persistAndReconcile(config: Record<string, unknown>, summary: string): Promise<void> {
  writeFileSync(CONFIG_PATH, stringify(config), "utf8");
  await reconfigureCmd();
  await syncProxyConfig();
  if (idpEnabled(config)) {
    await syncIdpConfig();
  }
  console.log(success(summary));
}

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

async function statusCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const manage = configString(config, "terrarium_manage_domain");
  const lxd = configString(config, "terrarium_lxd_domain");
  const auth = configString(config, "terrarium_auth_domain");
  const oidc = oidcIssuer(config);
  const mode = idpMode(config);
  const idp = idpEnabled(config);

  const traefik = await runAllowFailure(["systemctl", "is-active", "traefik"]);
  const cockpit = await runAllowFailure(["systemctl", "is-active", "cockpit.socket"]);
  const lxdState = await runAllowFailure(["systemctl", "is-active", "snap.lxd.daemon"]);
  const zitadel = idp ? await runAllowFailure(["systemctl", "is-active", "terrarium-zitadel.service"]) : null;
  const s3Timer = await runAllowFailure(["systemctl", "is-active", "terrarium-s3-backup.timer"]);
  const syncoidTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-syncoid.timer"]);
  const traefikSyncTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-traefik-sync.timer"]);

  console.log(heading("Terrarium status"));
  console.log(`  ${label("Config:")} ${value(CONFIG_PATH)}`);
  console.log(`  ${label("Pool:")} ${value(pool)}`);
  console.log(`  ${label("Cockpit:")} ${value(`https://${manage}`)}`);
  console.log(`  ${label("LXD:")} ${value(`https://${lxd}`)}`);
  console.log(`  ${label("IDP mode:")} ${value(mode)}`);
  if (oidc) {
    console.log(`  ${label("OIDC issuer:")} ${value(oidc)}`);
  }
  if (idp) {
    console.log(`  ${label("ZITADEL:")} ${value(`https://${auth}`)}`);
    console.log(`  ${label("ZITADEL bootstrap password:")} ${value("/etc/terrarium/secrets/zitadel_admin_password")}`);
  }
  console.log(`  ${label("traefik:")} ${value(traefik.stdout.trim())}`);
  console.log(`  ${label("cockpit.socket:")} ${value(cockpit.stdout.trim())}`);
  console.log(`  ${label("lxd:")} ${value(lxdState.stdout.trim())}`);
  if (zitadel) {
    console.log(`  ${label("terrarium-zitadel.service:")} ${value(zitadel.stdout.trim())}`);
  }
  console.log(`  ${label("terrarium-s3-backup.timer:")} ${value(s3Timer.stdout.trim())}`);
  console.log(`  ${label("terrarium-syncoid.timer:")} ${value(syncoidTimer.stdout.trim())}`);
  console.log(`  ${label("terrarium-traefik-sync.timer:")} ${value(traefikSyncTimer.stdout.trim())}`);
}

async function backupListCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const bucket = configString(config, "terrarium_s3_bucket");
  const prefix = configString(config, "terrarium_s3_prefix", "terrarium");
  const endpoint = configString(config, "terrarium_s3_endpoint");
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

async function confirmDestructive(message: string): Promise<void> {
  const approved = await confirm({ message, default: false });
  if (!approved) {
    throw new Error("operation cancelled");
  }
}

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

async function handOffToLxdRecover(): Promise<void> {
  console.log(`\n${label("Starting:")} ${value("lxd recover")}`);
  await runInteractive(["lxd", "recover"], PREFIX);
}

async function restoreLocal(
  config: Record<string, unknown>,
  instance: string,
  at: string,
  mode: "in-place" | "as-new",
  newName: string
): Promise<void> {
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
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

async function restoreS3(
  config: Record<string, unknown>,
  instance: string,
  at: string,
  mode: "in-place" | "as-new",
  newName: string
): Promise<void> {
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
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

async function backupRestoreCmd(
  source: string,
  instance: string,
  at: string,
  options: { asNew?: string }
): Promise<void> {
  const config = requireConfig();
  const mode = options.asNew ? "as-new" : "in-place";
  const newName = options.asNew ?? "";

  if (source === "local") {
    await restoreLocal(config, instance, at, mode, newName);
  } else if (source === "s3") {
    await restoreS3(config, instance, at, mode, newName);
  } else {
    throw new Error(`unsupported restore source: ${source}`);
  }
}

async function reconfigureCmd(): Promise<void> {
  if (!existsSync("/opt/terrarium/ansible/site.yml")) {
    throw new Error("/opt/terrarium/ansible/site.yml not found");
  }
  if (!existsSync("/opt/terrarium/dist/terrariumctl")) {
    throw new Error("compiled Terrarium binaries are missing from /opt/terrarium/dist; rerun install.sh");
  }
  await runText(
    ["ansible-playbook", "-i", "/opt/terrarium/ansible/inventory.ini", "/opt/terrarium/ansible/site.yml", "-e", `@${CONFIG_PATH}`],
    PREFIX,
    { cwd: "/opt/terrarium" }
  );
}

async function setDomainsCmd(
  rootDomainArg?: string,
  options: { manageDomain?: string; lxdDomain?: string; authDomain?: string } = {}
): Promise<void> {
  const config = loadMutableConfig();
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain =
    rootDomainArg ||
    (await input({
      message: "Root domain",
      default: configString(config, "terrarium_root_domain"),
      validate: (value) => (value.trim() ? true : "Root domain is required")
    }));

  setConfigValue(config, "terrarium_root_domain", rootDomain);
  setConfigValue(config, "terrarium_manage_domain", options.manageDomain || defaultServiceDomain(rootDomain, publicIp, "manage"));
  setConfigValue(config, "terrarium_lxd_domain", options.lxdDomain || defaultServiceDomain(rootDomain, publicIp, "lxd"));
  if (idpEnabled(config)) {
    const authDomain = options.authDomain || defaultServiceDomain(rootDomain, publicIp, "auth");
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(`https://${authDomain}/`, "--oidc"));
  }

  await confirmDestructive(
    `Apply domains: manage=${String(config.terrarium_manage_domain)}, lxd=${String(config.terrarium_lxd_domain)}${
      config.terrarium_auth_domain ? `, auth=${String(config.terrarium_auth_domain)}` : ""
    }?`
  );
  await persistAndReconcile(config, "Updated domains");
}

async function setEmailsCmd(options: { email?: string; acmeEmail?: string; zitadelAdminEmail?: string }): Promise<void> {
  const config = loadMutableConfig();
  if (!options.email && !options.acmeEmail && !options.zitadelAdminEmail) {
    throw new Error("set emails requires at least one of --email, --acme-email, or --zitadel-admin-email");
  }
  if (options.email) {
    setConfigValue(config, "terrarium_email", validateEmail(options.email, "--email"));
  }
  if (options.acmeEmail) {
    setConfigValue(config, "terrarium_acme_email", validateEmail(options.acmeEmail, "--acme-email"));
  } else if (!configString(config, "terrarium_acme_email")) {
    setConfigValue(config, "terrarium_acme_email", configString(config, "terrarium_email"));
  }
  if (options.zitadelAdminEmail) {
    setConfigValue(config, "terrarium_zitadel_admin_email", validateEmail(options.zitadelAdminEmail, "--zitadel-admin-email"));
  }
  await persistAndReconcile(config, "Updated email settings");
}

async function setIdpCmd(options: {
  mode: string;
  authDomain?: string;
  oidc?: string;
  oidcClient?: string;
  oidcSecret?: string;
  zitadelAdminEmail?: string;
}): Promise<void> {
  const config = loadMutableConfig();
  const publicIp = configString(config, "terrarium_public_ip");
  const rootDomain = configString(config, "terrarium_root_domain");
  const nextMode = options.mode.trim().toLowerCase();
  if (!["local", "oidc"].includes(nextMode)) {
    throw new Error("set idp requires mode 'local' or 'oidc'");
  }

  setConfigValue(config, "terrarium_idp_mode", nextMode);
  if (nextMode === "local") {
    const authDomain = options.authDomain || configString(config, "terrarium_auth_domain") || defaultServiceDomain(rootDomain, publicIp, "auth");
    setConfigValue(config, "terrarium_auth_domain", authDomain);
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(`https://${authDomain}/`, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", "");
    setConfigValue(config, "terrarium_oidc_client_secret", "");
    const currentAdmin = options.zitadelAdminEmail || configString(config, "terrarium_zitadel_admin_email") || configString(config, "terrarium_email");
    setConfigValue(config, "terrarium_zitadel_admin_email", validateEmail(currentAdmin, "--zitadel-admin-email"));
  } else {
    const currentIssuer = oidcIssuer(config);
    const issuer = options.oidc || currentIssuer;
    if (!issuer) {
      throw new Error("--oidc is required when mode is oidc");
    }
    const clientId = options.oidcClient || configString(config, "terrarium_oidc_client_id");
    const clientSecret = options.oidcSecret || configString(config, "terrarium_oidc_client_secret");
    if (!clientId) {
      throw new Error("--oidc-client is required when mode is oidc");
    }
    if (!clientSecret) {
      throw new Error("--oidc-secret is required when mode is oidc");
    }
    setConfigValue(config, "terrarium_auth_domain", "");
    setConfigValue(config, "terrarium_oidc_issuer", normalizeOidcIssuer(issuer, "--oidc"));
    setConfigValue(config, "terrarium_oidc_client_id", clientId);
    setConfigValue(config, "terrarium_oidc_client_secret", clientSecret);
  }

  await persistAndReconcile(config, nextMode === "local" ? "Switched IDP mode to local" : "Switched IDP mode to oidc");
}

async function setS3Cmd(options: {
  enable?: boolean;
  disable?: boolean;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}): Promise<void> {
  const config = loadMutableConfig();
  if (options.enable && options.disable) {
    throw new Error("set s3 accepts only one of --enable or --disable");
  }
  const nextEnabled = options.enable ? true : options.disable ? false : configBoolean(config, "terrarium_enable_s3");
  setConfigValue(config, "terrarium_enable_s3", nextEnabled);

  if (options.s3Endpoint !== undefined) setConfigValue(config, "terrarium_s3_endpoint", options.s3Endpoint);
  if (options.s3Bucket !== undefined) setConfigValue(config, "terrarium_s3_bucket", options.s3Bucket);
  if (options.s3Region !== undefined) setConfigValue(config, "terrarium_s3_region", options.s3Region);
  if (options.s3Prefix !== undefined) setConfigValue(config, "terrarium_s3_prefix", options.s3Prefix);
  if (options.s3AccessKey !== undefined) setConfigValue(config, "terrarium_s3_access_key", options.s3AccessKey);
  if (options.s3SecretKey !== undefined) setConfigValue(config, "terrarium_s3_secret_key", options.s3SecretKey);

  if (nextEnabled) {
    if (!configString(config, "terrarium_s3_bucket")) throw new Error("S3 requires --s3-bucket");
    if (!configString(config, "terrarium_s3_access_key")) throw new Error("S3 requires --s3-access-key");
    if (!configString(config, "terrarium_s3_secret_key")) throw new Error("S3 requires --s3-secret-key");
    if (!configString(config, "terrarium_s3_prefix")) setConfigValue(config, "terrarium_s3_prefix", "terrarium");
  }

  await persistAndReconcile(config, nextEnabled ? "Updated S3 settings" : "Disabled S3 backups");
}

async function setSyncoidCmd(options: {
  enable?: boolean;
  disable?: boolean;
  syncoidTarget?: string;
  syncoidTargetDataset?: string;
  syncoidSshKey?: string;
}): Promise<void> {
  const config = loadMutableConfig();
  if (options.enable && options.disable) {
    throw new Error("set syncoid accepts only one of --enable or --disable");
  }
  const nextEnabled = options.enable ? true : options.disable ? false : configBoolean(config, "terrarium_enable_syncoid");
  setConfigValue(config, "terrarium_enable_syncoid", nextEnabled);

  if (options.syncoidTarget !== undefined) setConfigValue(config, "terrarium_syncoid_target", options.syncoidTarget);
  if (options.syncoidTargetDataset !== undefined) setConfigValue(config, "terrarium_syncoid_target_dataset", options.syncoidTargetDataset);
  if (options.syncoidSshKey !== undefined) setConfigValue(config, "terrarium_syncoid_ssh_key", options.syncoidSshKey);

  if (nextEnabled) {
    if (!configString(config, "terrarium_syncoid_target")) throw new Error("syncoid requires --syncoid-target");
    if (!configString(config, "terrarium_syncoid_target_dataset")) throw new Error("syncoid requires --syncoid-target-dataset");
    if (!configString(config, "terrarium_syncoid_ssh_key")) {
      setConfigValue(config, "terrarium_syncoid_ssh_key", "/root/.ssh/id_ed25519");
    }
  }

  await persistAndReconcile(config, nextEnabled ? "Updated syncoid settings" : "Disabled syncoid replication");
}

const cli = cac("terrariumctl");

registerInstallCommand(cli);

cli.command("status", "Show Terrarium service and endpoint status").action(async () => {
  await statusCmd();
});

cli
  .command("backup <action>", "Backup operations: list, export, restore")
  .option("--source <source>", "Restore source: local or s3")
  .option("--instance <name>", "Instance name")
  .option("--at <snapshotOrTimestamp>", "Snapshot name fragment or timestamp")
  .option("--as-new <name>", "Restore as a new instance")
  .usage("backup list | backup export | backup restore [--source local|s3] --instance NAME [--at SNAPSHOT|TIMESTAMP] [--as-new NEWNAME]")
  .action(async (action, options) => {
    if (action === "list") {
      await backupListCmd();
      return;
    }
    if (action === "export") {
      await backupExportCmd();
      return;
    }
    if (action === "restore") {
      const source = (options.source as string | undefined) || "local";
      const instance = options.instance as string | undefined;
      const at = (options.at as string | undefined) || "";
      const asNew = options.asNew as string | undefined;
      if (!instance) {
        throw new Error("backup restore requires --instance; --source defaults to local, --at defaults to the latest restore point, and --as-new is optional");
      }
      await backupRestoreCmd(source, instance, at, { asNew });
      return;
    }
    throw new Error(`unsupported backup action: ${action}`);
  });

cli.command("reconfigure", "Re-run the Ansible reconciliation with the installed binary").action(async () => {
  await reconfigureCmd();
});

cli
  .command("proxy <action>", "Proxy operations")
  .usage("proxy sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported proxy action: ${action}`);
    }
    await syncProxyConfig();
  });

cli
  .command("idp <action>", "Identity provider operations")
  .usage("idp sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported idp action: ${action}`);
    }
    await syncIdpConfig();
  });

cli
  .command("set <section> [value]", "Update persisted Terrarium configuration")
  .option("--manage-domain <domain>", "Override the Cockpit domain")
  .option("--lxd-domain <domain>", "Override the LXD domain")
  .option("--auth-domain <domain>", "Override the ZITADEL domain")
  .option("--email <email>", "Terrarium contact/admin email")
  .option("--acme-email <email>", "ACME account email")
  .option("--zitadel-admin-email <email>", "ZITADEL bootstrap admin email")
  .option("--oidc <issuer>", "External OIDC issuer URL")
  .option("--oidc-client <clientId>", "External OIDC client ID")
  .option("--oidc-secret <clientSecret>", "External OIDC client secret")
  .option("--s3-endpoint <url>", "S3 endpoint URL")
  .option("--s3-bucket <name>", "S3 bucket name")
  .option("--s3-region <name>", "S3 region")
  .option("--s3-prefix <prefix>", "S3 object prefix")
  .option("--s3-access-key <key>", "S3 access key")
  .option("--s3-secret-key <secret>", "S3 secret key")
  .option("--syncoid-target <host>", "Remote syncoid SSH target")
  .option("--syncoid-target-dataset <dataset>", "Remote syncoid dataset")
  .option("--syncoid-ssh-key <path>", "SSH key path for syncoid")
  .option("--enable", "Enable the selected integration")
  .option("--disable", "Disable the selected integration")
  .usage("set domains [rootDomain] | set emails | set idp local|oidc | set s3 | set syncoid")
  .action(async (section, value, options) => {
    const cliOptions = options as Record<string, unknown>;
    if (section === "domains") {
      await setDomainsCmd((value as string | undefined) || "", {
        manageDomain: cliOption(cliOptions, "manageDomain"),
        lxdDomain: cliOption(cliOptions, "lxdDomain"),
        authDomain: cliOption(cliOptions, "authDomain")
      });
      return;
    }
    if (section === "emails") {
      await setEmailsCmd({
        email: cliOption(cliOptions, "email"),
        acmeEmail: cliOption(cliOptions, "acmeEmail"),
        zitadelAdminEmail: cliOption(cliOptions, "zitadelAdminEmail")
      });
      return;
    }
    if (section === "idp") {
      await setIdpCmd({
        mode: value as string,
        authDomain: cliOption(cliOptions, "authDomain"),
        oidc: cliOption(cliOptions, "oidc"),
        oidcClient: cliOption(cliOptions, "oidcClient"),
        oidcSecret: cliOption(cliOptions, "oidcSecret"),
        zitadelAdminEmail: cliOption(cliOptions, "zitadelAdminEmail")
      });
      return;
    }
    if (section === "s3") {
      await setS3Cmd({
        enable: Boolean(cliOptions.enable),
        disable: Boolean(cliOptions.disable),
        s3Endpoint: cliOption(cliOptions, "s3Endpoint", ["s3-endpoint"]),
        s3Bucket: cliOption(cliOptions, "s3Bucket", ["s3-bucket"]),
        s3Region: cliOption(cliOptions, "s3Region", ["s3-region"]),
        s3Prefix: cliOption(cliOptions, "s3Prefix", ["s3-prefix"]),
        s3AccessKey: cliOption(cliOptions, "s3AccessKey", ["s3-accessKey", "s3-access-key"]),
        s3SecretKey: cliOption(cliOptions, "s3SecretKey", ["s3-secretKey", "s3-secret-key"])
      });
      return;
    }
    if (section === "syncoid") {
      await setSyncoidCmd({
        enable: Boolean(cliOptions.enable),
        disable: Boolean(cliOptions.disable),
        syncoidTarget: cliOption(cliOptions, "syncoidTarget"),
        syncoidTargetDataset: cliOption(cliOptions, "syncoidTargetDataset"),
        syncoidSshKey: cliOption(cliOptions, "syncoidSshKey")
      });
      return;
    }
    throw new Error(`unsupported set section: ${section}`);
  });

cli.help();

try {
  cli.parse(normalizedArgv(process.argv), { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  console.error(chalk.red(`${PREFIX}: ${String(error).replace(/^Error: /, "")}`));
  process.exit(1);
}
