import { backupActionCmd } from "./backup";
import { PREFIX, heading, label, requireConfig, success, value, type MutableConfig } from "./context";
import {
  localIdpComposeLogsCommand,
  localIdpComposePsCommand,
  localIdpInfoCommand,
  localIdpRuntimeDescriptor,
  unmanagedLocalIdpRuntimeMessage
} from "./idp-runtime";
import { backupExportCmd } from "../terrarium-s3-export";
import { configBoolean, configString, runAllowFailure, runText } from "../lib/common";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type IdpCommandDeps = {
  config?: MutableConfig;
  requireConfig?: () => MutableConfig;
  runAllowFailure?: (cmd: string[]) => Promise<CommandResult>;
  runText?: (cmd: string[], prefix: string) => Promise<string>;
  backupExport?: () => Promise<void>;
  backupAction?: typeof backupActionCmd;
  now?: () => Date;
  log?: (message: string) => void;
};

function commandConfig(deps: IdpCommandDeps): MutableConfig {
  return deps.config ?? (deps.requireConfig ?? requireConfig)();
}

export async function idpStatusCmd(deps: IdpCommandDeps = {}): Promise<void> {
  const config = commandConfig(deps);
  const runtime = localIdpRuntimeDescriptor(config);
  const log = deps.log ?? console.log;
  if (!runtime) {
    log(unmanagedLocalIdpRuntimeMessage());
    return;
  }

  log(heading(`${runtime.label} system instance`));
  const info = await (deps.runAllowFailure ?? runAllowFailure)(localIdpInfoCommand(runtime));
  if (info.exitCode !== 0) {
    log(`${label("Instance:")} ${value("missing")}`);
    log(info.stderr.trim() || info.stdout.trim());
    return;
  }
  log(info.stdout.trim());

  log(`\n${heading(`${runtime.label} compose services`)}`);
  const compose = await (deps.runAllowFailure ?? runAllowFailure)(localIdpComposePsCommand(runtime));
  log((compose.stdout || compose.stderr).trim());
}

export async function idpLogsCmd(lines = "120", deps: IdpCommandDeps = {}): Promise<void> {
  const config = commandConfig(deps);
  const runtime = localIdpRuntimeDescriptor(config);
  const log = deps.log ?? console.log;
  if (!runtime) {
    log(unmanagedLocalIdpRuntimeMessage());
    return;
  }

  const logs = await (deps.runText ?? runText)(localIdpComposeLogsCommand(runtime, lines), PREFIX);
  log(logs.trim());
}

function manualSnapshotName(now = new Date()): string {
  return `idp-manual-${now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z")}`;
}

export async function idpBackupCmd(deps: IdpCommandDeps = {}): Promise<void> {
  const config = commandConfig(deps);
  const runtime = localIdpRuntimeDescriptor(config);
  if (!runtime) {
    throw new Error(unmanagedLocalIdpRuntimeMessage());
  }

  const pool = configString(config, "terrarium_lxd_pool_name", "terrarium");
  const snapshot = `${pool}/containers/${runtime.instanceName}@${manualSnapshotName((deps.now ?? (() => new Date()))())}`;

  await (deps.runText ?? runText)(["zfs", "snapshot", "-r", snapshot], PREFIX);
  (deps.log ?? console.log)(success(`Created ${snapshot}`));

  if (configBoolean(config, "terrarium_enable_s3")) {
    await (deps.backupExport ?? backupExportCmd)();
    (deps.log ?? console.log)(success("Exported current backup chain to S3"));
  }
}

export async function idpRestoreCmd(options: { source?: string; at?: string; asNew?: string }, deps: IdpCommandDeps = {}): Promise<void> {
  const config = commandConfig(deps);
  const runtime = localIdpRuntimeDescriptor(config);
  if (!runtime) {
    throw new Error(unmanagedLocalIdpRuntimeMessage());
  }

  await (deps.backupAction ?? backupActionCmd)("restore", {
    source: options.source,
    instance: runtime.instanceName,
    at: options.at,
    asNew: options.asNew
  });
}
