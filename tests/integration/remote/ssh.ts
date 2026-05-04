import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run, runAllowFailure, shellEscape } from "../lib/process";
import { IntegrationLogger } from "../lib/logger";

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const REMOTE_READ_ATTEMPTS = 5;
const REMOTE_READ_TIMEOUT_MS = 20000;
export const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_SSH_HOUSEKEEPING_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_SSH_HOUSEKEEPING_ATTEMPTS = 4;
export const DEFAULT_SCP_COMMAND_TIMEOUT_MS = 90 * 1000;
export const DEFAULT_SCP_ATTEMPTS = 4;

export function sshCommandTimeoutMs(options: { timeoutMs?: number } = {}): number {
  return options.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS;
}

/** Converts an absolute remote path or glob into a tar include relative to `/`. */
export function remoteTarRootPattern(remotePath: string): string {
  const relativePath = remotePath.replace(/^\/+/, "");
  return relativePath || ".";
}

/**
 * Thin SSH client for driving ephemeral Terrarium test hosts.
 *
 * The integration suite uses plain `ssh`/`scp` so local manual runs and GitHub
 * Actions behave the same way and we avoid a second transport stack.
 */
export class SshHost {
  readonly host: string;
  readonly user: string;
  readonly keyPath: string;
  readonly logger: IntegrationLogger;

  constructor(host: string, user: string, keyPath: string, logger: IntegrationLogger) {
    this.host = host;
    this.user = user;
    this.keyPath = keyPath;
    this.logger = logger;
  }

  private connectionArgs(): string[] {
    return [
      "-i",
      this.keyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=20",
      "-o",
      "TCPKeepAlive=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null"
    ];
  }

  private baseArgs(): string[] {
    return [
      ...this.connectionArgs(),
      `${this.user}@${this.host}`
    ];
  }

  async waitForSsh(timeoutMs = 420000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastFailure = "";
    while (Date.now() < deadline) {
      const perAttemptTimeoutMs = Math.min(15000, Math.max(5000, deadline - Date.now()));
      const result = await runAllowFailure(["ssh", ...this.baseArgs(), "true"], { timeoutMs: perAttemptTimeoutMs });
      if (result.exitCode === 0) {
        return;
      }
      lastFailure = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      await Bun.sleep(5000);
    }
    const suffix = lastFailure ? `; last failure: ${lastFailure}` : "";
    throw new Error(`timed out waiting for SSH on ${this.host}${suffix}`);
  }

  async exec(command: string, options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<string> {
    const envPrefix =
      options.env && Object.keys(options.env).length > 0
        ? `${Object.entries(options.env)
            .map(([key, value]) => `${key}=${shellEscape(value)}`)
            .join(" ")} `
        : "";
    this.logger.info(`ssh ${this.host}: ${command}`);
    return await run(["ssh", ...this.baseArgs(), `${envPrefix}bash -lc ${shellEscape(command)}`], {
      timeoutMs: sshCommandTimeoutMs(options)
    });
  }

  async execAllowFailure(command: string, options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<SshExecResult> {
    const envPrefix =
      options.env && Object.keys(options.env).length > 0
        ? `${Object.entries(options.env)
            .map(([key, value]) => `${key}=${shellEscape(value)}`)
            .join(" ")} `
        : "";
    this.logger.info(`ssh ${this.host}: ${command}`);
    const result = await runAllowFailure(["ssh", ...this.baseArgs(), `${envPrefix}bash -lc ${shellEscape(command)}`], {
      timeoutMs: sshCommandTimeoutMs(options)
    });
    return result;
  }

  async execScript(script: string, remotePath: string): Promise<void> {
    const localTemp = join(dirname(this.logger.path), basename(remotePath));
    mkdirSync(dirname(localTemp), { recursive: true });
    writeFileSync(localTemp, script, { encoding: "utf8", mode: 0o700 });
    await this.copyTo(localTemp, remotePath);
    await this.execHousekeeping(`chmod 700 ${shellEscape(remotePath)}`, `chmod ${remotePath}`);
    await this.exec(shellEscape(remotePath));
  }

  async copyTo(localPath: string, remotePath: string): Promise<void> {
    this.logger.info(`scp ${localPath} -> ${this.host}:${remotePath}`);
    await this.scpWithRetries(
      [
        "scp",
        ...this.connectionArgs(),
        localPath,
        `${this.user}@${this.host}:${remotePath}`
      ],
      `scp ${localPath} to ${this.host}:${remotePath}`
    );
  }

  async read(remotePath: string): Promise<string> {
    let lastFailure = "";
    for (let attempt = 1; attempt <= REMOTE_READ_ATTEMPTS; attempt += 1) {
      const result = await this.execAllowFailure(`cat ${shellEscape(remotePath)}`, { timeoutMs: REMOTE_READ_TIMEOUT_MS });
      if (result.exitCode === 0) {
        return result.stdout;
      }
      lastFailure = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
      if (attempt < REMOTE_READ_ATTEMPTS) {
        await Bun.sleep(attempt * 1000);
      }
    }

    throw new Error(`failed to read ${remotePath} from ${this.host}: ${lastFailure}`);
  }

  async write(remotePath: string, content: string, mode = "600"): Promise<void> {
    const localTemp = join(dirname(this.logger.path), basename(remotePath));
    writeFileSync(localTemp, content, "utf8");
    await this.copyTo(localTemp, remotePath);
    await this.execHousekeeping(`chmod ${mode} ${shellEscape(remotePath)}`, `chmod ${remotePath}`);
  }

  async uploadKeypair(privateKeyPath: string, publicKeyPath: string, remotePrivateKeyPath: string): Promise<void> {
    await this.copyTo(privateKeyPath, remotePrivateKeyPath);
    await this.execHousekeeping(`chmod 600 ${shellEscape(remotePrivateKeyPath)}`, `chmod ${remotePrivateKeyPath}`);
    await this.copyTo(publicKeyPath, `${remotePrivateKeyPath}.pub`);
    await this.execHousekeeping(`chmod 644 ${shellEscape(`${remotePrivateKeyPath}.pub`)}`, `chmod ${remotePrivateKeyPath}.pub`);
  }

  async archive(remotePaths: string[], localPath: string): Promise<void> {
    const remoteTar = `/tmp/${basename(localPath)}.tar.gz`;
    const archivePatterns = remotePaths.map(remoteTarRootPattern);
    const archiveResult = await this.execAllowFailure(`
      patterns=(${archivePatterns.map((path) => shellEscape(path)).join(" ")})
      paths=()
      cd /
      for pattern in "\${patterns[@]}"; do
        if [ -e "$pattern" ]; then
          paths+=("$pattern")
          continue
        fi
        while IFS= read -r match; do
          [ -n "$match" ] && paths+=("$match")
        done < <(compgen -G "$pattern" || true)
      done
      if [ "\${#paths[@]}" -eq 0 ]; then
        tar -czf ${shellEscape(remoteTar)} --files-from /dev/null
      else
        timeout 120s tar \
          --warning=no-file-changed \
          --ignore-failed-read \
          --exclude='var/lib/terrarium/zitadel/postgres/pg_wal' \
          --exclude='var/lib/terrarium/zitadel/postgres/pg_wal/*' \
          -C / \
          -czf ${shellEscape(remoteTar)} -- "\${paths[@]}"
      fi
    `);
    if (archiveResult.exitCode !== 0) {
      throw new Error(archiveResult.stderr.trim() || archiveResult.stdout.trim() || `failed to archive host paths on ${this.host}`);
    }
    await this.scpWithRetries(
      [
        "scp",
        ...this.connectionArgs(),
        `${this.user}@${this.host}:${remoteTar}`,
        localPath
      ],
      `scp ${this.host}:${remoteTar} to ${localPath}`
    );
    await this.execHousekeeping(`rm -f ${shellEscape(remoteTar)}`, `remove ${remoteTar}`);
  }

  private async execHousekeeping(command: string, description: string): Promise<string> {
    let lastFailure = "";
    this.logger.info(`ssh ${this.host}: ${command}`);
    for (let attempt = 1; attempt <= DEFAULT_SSH_HOUSEKEEPING_ATTEMPTS; attempt += 1) {
      const result = await runAllowFailure(["ssh", ...this.baseArgs(), `bash -lc ${shellEscape(command)}`], {
        timeoutMs: DEFAULT_SSH_HOUSEKEEPING_TIMEOUT_MS
      });
      if (result.exitCode === 0) {
        return result.stdout;
      }

      lastFailure = formatCommandResult(result);
      if (attempt < DEFAULT_SSH_HOUSEKEEPING_ATTEMPTS && isRetryableHousekeepingFailure(result)) {
        this.logger.warn(
          `${description} failed on attempt ${attempt}/${DEFAULT_SSH_HOUSEKEEPING_ATTEMPTS}; retrying: ${compactCommandOutput(lastFailure)}`
        );
        await Bun.sleep(attempt * 1000);
        continue;
      }
      break;
    }

    throw new Error(`${description} failed after SSH housekeeping retries\n${lastFailure}`);
  }

  private async scpWithRetries(cmd: string[], description: string): Promise<void> {
    let lastFailure = "";
    for (let attempt = 1; attempt <= DEFAULT_SCP_ATTEMPTS; attempt += 1) {
      const result = await runAllowFailure(cmd, { timeoutMs: DEFAULT_SCP_COMMAND_TIMEOUT_MS });
      if (result.exitCode === 0) {
        return;
      }

      lastFailure = formatCommandResult(result);
      if (attempt < DEFAULT_SCP_ATTEMPTS) {
        this.logger.warn(`${description} failed on attempt ${attempt}/${DEFAULT_SCP_ATTEMPTS}; retrying: ${compactCommandOutput(lastFailure)}`);
        await this.waitForSsh(45000).catch(() => undefined);
        await Bun.sleep(attempt * 2000);
      }
    }

    throw new Error(`${description} failed after ${DEFAULT_SCP_ATTEMPTS} attempts\n${lastFailure}`);
  }

  /**
   * Starts a long-running shell command remotely without holding the SSH session open.
   *
   * Terrarium install and reconfigure flows can restart SSH-related services.
   * Detached execution plus a status file lets the harness reconnect and keep
   * observing progress instead of treating that restart as a hard failure.
   */
  async execDetached(command: string, remoteScriptPath: string, remoteStatusPath: string, remoteLogPath: string): Promise<void> {
    const script = `#!/usr/bin/env bash
set -euo pipefail
set +e
(
  ${command}
) >${shellEscape(remoteLogPath)} 2>&1
status=$?
printf '%s\n' "$status" >${shellEscape(remoteStatusPath)}
exit "$status"
`;
    await this.write(remoteScriptPath, script, "700");
    await this.exec(`nohup ${shellEscape(remoteScriptPath)} >/dev/null 2>&1 &`);
  }
}

function isRetryableHousekeepingFailure(result: SshExecResult): boolean {
  return result.exitCode === 124 || result.exitCode === 255;
}

function formatCommandResult(result: SshExecResult): string {
  const parts = [`exit ${result.exitCode}`];
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

function compactCommandOutput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "<empty>";
}
