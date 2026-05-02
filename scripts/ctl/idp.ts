import { backupActionCmd } from "./backup";
import { PREFIX, heading, label, requireConfig, success, value } from "./context";
import { backupExportCmd } from "../terrarium-s3-export";
import { configBoolean, configString, runAllowFailure, runText } from "../lib/common";

const DEFAULT_IDP_INSTANCE = "terrarium-idp";

function idpInstanceName(): string {
  return configString(requireConfig(), "terrarium_zitadel_instance_name", DEFAULT_IDP_INSTANCE);
}

export async function idpStatusCmd(): Promise<void> {
  const instance = idpInstanceName();
  console.log(heading("ZITADEL system instance"));
  const info = await runAllowFailure(["lxc", "info", instance]);
  if (info.exitCode !== 0) {
    console.log(`${label("Instance:")} ${value("missing")}`);
    console.log(info.stderr.trim() || info.stdout.trim());
    return;
  }
  console.log(info.stdout.trim());

  console.log(`\n${heading("ZITADEL compose services")}`);
  const compose = await runAllowFailure([
    "lxc",
    "exec",
    instance,
    "--",
    "docker",
    "compose",
    "--project-name",
    "terrarium-zitadel",
    "-f",
    "/var/lib/terrarium/zitadel/docker-compose.yml",
    "ps"
  ]);
  console.log((compose.stdout || compose.stderr).trim());
}

export async function idpLogsCmd(lines = "120"): Promise<void> {
  const instance = idpInstanceName();
  const logs = await runText(
    [
      "lxc",
      "exec",
      instance,
      "--",
      "docker",
      "compose",
      "--project-name",
      "terrarium-zitadel",
      "-f",
      "/var/lib/terrarium/zitadel/docker-compose.yml",
      "logs",
      "--tail",
      lines
    ],
    PREFIX
  );
  console.log(logs.trim());
}

function manualSnapshotName(): string {
  return `idp-manual-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`;
}

export async function idpBackupCmd(): Promise<void> {
  const config = requireConfig();
  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const instance = configString(config, "terrarium_zitadel_instance_name", DEFAULT_IDP_INSTANCE);
  const snapshot = `${pool}/containers/${instance}@${manualSnapshotName()}`;

  await runText(["zfs", "snapshot", "-r", snapshot], PREFIX);
  console.log(success(`Created ${snapshot}`));

  if (configBoolean(config, "terrarium_enable_s3")) {
    await backupExportCmd();
    console.log(success("Exported current backup chain to S3"));
  }
}

export async function idpRestoreCmd(options: { source?: string; at?: string; asNew?: string }): Promise<void> {
  await backupActionCmd("restore", {
    source: options.source,
    instance: idpInstanceName(),
    at: options.at,
    asNew: options.asNew
  });
}
