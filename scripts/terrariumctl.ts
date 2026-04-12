import { confirm, input } from "@inquirer/prompts";
import { cac } from "cac";
import chalk from "chalk";
import { existsSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { registerInstallCommand } from "./terrarium-install";
import { backupExportCmd } from "./terrarium-s3-export";
import { proxySyncCmd as syncProxyConfig } from "./terrarium-traefik-sync";
import { idpSyncCmd as syncIdpConfig } from "./terrarium-zitadel-sync";
import { reconstructFromS3 } from "./terrarium-zfs-reconstruct";
import { configBoolean, configString, loadConfig, runAllowFailure, runText } from "./lib/common";

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

async function findSnapshot(dataset: string, query: string): Promise<string> {
  const stdout = await runText(["zfs", "list", "-H", "-t", "snapshot", "-o", "name", "-s", "creation"], PREFIX);
  let match = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${dataset}@`) && line.includes(query)) {
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
  const idpMode = configString(config, "terrarium_idp_mode");

  const traefik = await runAllowFailure(["systemctl", "is-active", "traefik"]);
  const cockpit = await runAllowFailure(["systemctl", "is-active", "cockpit.socket"]);
  const lxdState = await runAllowFailure(["systemctl", "is-active", "snap.lxd.daemon"]);
  const zitadel = idpMode === "zitadel_self_hosted" ? await runAllowFailure(["systemctl", "is-active", "terrarium-zitadel.service"]) : null;
  const s3Timer = await runAllowFailure(["systemctl", "is-active", "terrarium-s3-backup.timer"]);
  const syncoidTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-syncoid.timer"]);
  const traefikSyncTimer = await runAllowFailure(["systemctl", "is-active", "terrarium-traefik-sync.timer"]);

  console.log(heading("Terrarium status"));
  console.log(`  ${label("Config:")} ${value(CONFIG_PATH)}`);
  console.log(`  ${label("Pool:")} ${value(pool)}`);
  console.log(`  ${label("Cockpit:")} ${value(`https://${manage}`)}`);
  console.log(`  ${label("LXD:")} ${value(`https://${lxd}`)}`);
  if (idpMode === "zitadel_self_hosted") {
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
    const output = (await runAllowFailure([...awsBase, "s3", "ls", `s3://${bucket}/${prefix}/manifests/`, "--recursive"])).stdout.trim();
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
    throw new Error(`no local snapshot matched '${at}'`);
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
  await runText(["zfs", "clone", snapshot, `${pool}/containers/${newName}`], PREFIX);
  console.log(success(`Cloned ${snapshot} to ${pool}/containers/${newName}`));
  console.log(`${label("Next:")} ${value(`run lxd recover and import the new dataset as instance ${newName}`)}`);
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
    console.log(`${label("Next:")} ${value(`run lxd recover and import the new dataset as instance ${newName}`)}`);
  }
}

async function backupRestoreCmd(
  source: string,
  instance: string,
  at: string,
  options: { asNew?: string; inPlace?: boolean }
): Promise<void> {
  const config = requireConfig();
  const mode = options.inPlace ? "in-place" : "as-new";
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
  await runText(["ansible-playbook", "-i", "/opt/terrarium/ansible/inventory.ini", "/opt/terrarium/ansible/site.yml", "-e", `@${CONFIG_PATH}`], PREFIX);
}

async function setdomainCmd(
  rootDomainArg?: string,
  options: { manageDomain?: string; lxdDomain?: string; authDomain?: string } = {}
): Promise<void> {
  const rootDomain =
    rootDomainArg ??
    (await input({
      message: "Root domain",
      validate: (value) => (value.trim() ? true : "Root domain is required")
    }));

  const rendered = parse(Bun.file(CONFIG_PATH).textSync()) as Record<string, unknown>;
  rendered.terrarium_root_domain = rootDomain;
  rendered.terrarium_manage_domain = options.manageDomain || `manage.${rootDomain}`;
  rendered.terrarium_lxd_domain = options.lxdDomain || `lxd.${rootDomain}`;
  if (rendered.terrarium_idp_mode === "zitadel_self_hosted" || rendered.terrarium_auth_domain) {
    rendered.terrarium_auth_domain = options.authDomain || `auth.${rootDomain}`;
  }

  await confirmDestructive(
    `Apply domains: manage=${String(rendered.terrarium_manage_domain)}, lxd=${String(rendered.terrarium_lxd_domain)}${
      rendered.terrarium_auth_domain ? `, auth=${String(rendered.terrarium_auth_domain)}` : ""
    }?`
  );

  writeFileSync(CONFIG_PATH, stringify(rendered), "utf8");
  await reconfigureCmd();
  await syncProxyConfig();
  if (configString(rendered, "terrarium_idp_mode") === "zitadel_self_hosted") {
    await syncIdpConfig();
  }

  console.log(success("Updated domains"));
  console.log(`  ${label("Cockpit:")} ${value(`https://${rendered.terrarium_manage_domain}`)}`);
  console.log(`  ${label("LXD:")} ${value(`https://${rendered.terrarium_lxd_domain}`)}`);
  if (rendered.terrarium_idp_mode === "zitadel_self_hosted") {
    console.log(`  ${label("ZITADEL:")} ${value(`https://${rendered.terrarium_auth_domain}`)}`);
  }
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
  .option("--in-place", "Restore in place")
  .usage("list | export | restore --source local|s3 --instance NAME --at SNAPSHOT|TIMESTAMP --as-new NEWNAME|--in-place")
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
      const source = options.source as string | undefined;
      const instance = options.instance as string | undefined;
      const at = options.at as string | undefined;
      const asNew = options.asNew as string | undefined;
      const inPlace = Boolean(options.inPlace);
      if (!source || !instance || !at || (!asNew && !inPlace) || (asNew && inPlace)) {
        throw new Error("backup restore requires --source, --instance, --at, and exactly one of --as-new/--in-place");
      }
      await backupRestoreCmd(source, instance, at, { asNew, inPlace });
      return;
    }
    throw new Error(`unsupported backup action: ${action}`);
  });

cli.command("reconfigure", "Re-run the Ansible reconciliation with the installed binary").action(async () => {
  await reconfigureCmd();
});

cli
  .command("proxy <action>", "Proxy operations")
  .usage("sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported proxy action: ${action}`);
    }
    await syncProxyConfig();
  });

cli
  .command("idp <action>", "Identity provider operations")
  .usage("sync")
  .action(async (action) => {
    if (action !== "sync") {
      throw new Error(`unsupported idp action: ${action}`);
    }
    await syncIdpConfig();
  });

cli
  .command("setdomain [rootDomain]", "Update the root domain and derived Terrarium subdomains")
  .option("--manage-domain <domain>", "Override the Cockpit domain")
  .option("--lxd-domain <domain>", "Override the LXD domain")
  .option("--auth-domain <domain>", "Override the ZITADEL domain")
  .action(async (rootDomain, options) => {
    await setdomainCmd(rootDomain, {
      manageDomain: options.manageDomain as string | undefined,
      lxdDomain: options.lxdDomain as string | undefined,
      authDomain: options.authDomain as string | undefined
    });
  });

cli.help();

try {
  cli.parse(normalizedArgv(process.argv), { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  console.error(chalk.red(`${PREFIX}: ${String(error).replace(/^Error: /, "")}`));
  process.exit(1);
}
