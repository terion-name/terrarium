import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { run, runAllowFailure, shellEscape } from "../lib/process";
import { IntegrationLogger } from "../lib/logger";

export type SshExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

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

  private baseArgs(): string[] {
    return [
      "-i",
      this.keyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${this.user}@${this.host}`
    ];
  }

  async waitForSsh(timeoutMs = 180000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await runAllowFailure(["ssh", ...this.baseArgs(), "true"]);
      if (result.exitCode === 0) {
        return;
      }
      await Bun.sleep(5000);
    }
    throw new Error(`timed out waiting for SSH on ${this.host}`);
  }

  async exec(command: string, options: { env?: Record<string, string> } = {}): Promise<string> {
    const envPrefix =
      options.env && Object.keys(options.env).length > 0
        ? `${Object.entries(options.env)
            .map(([key, value]) => `${key}=${shellEscape(value)}`)
            .join(" ")} `
        : "";
    this.logger.info(`ssh ${this.host}: ${command}`);
    return await run(["ssh", ...this.baseArgs(), `${envPrefix}bash -lc ${shellEscape(command)}`]);
  }

  async execAllowFailure(command: string, options: { env?: Record<string, string> } = {}): Promise<SshExecResult> {
    const envPrefix =
      options.env && Object.keys(options.env).length > 0
        ? `${Object.entries(options.env)
            .map(([key, value]) => `${key}=${shellEscape(value)}`)
            .join(" ")} `
        : "";
    this.logger.info(`ssh ${this.host}: ${command}`);
    const result = await runAllowFailure(["ssh", ...this.baseArgs(), `${envPrefix}bash -lc ${shellEscape(command)}`]);
    return result;
  }

  async execScript(script: string, remotePath: string): Promise<void> {
    const localTemp = join(dirname(this.logger.path), basename(remotePath));
    mkdirSync(dirname(localTemp), { recursive: true });
    writeFileSync(localTemp, script, { encoding: "utf8", mode: 0o700 });
    await this.copyTo(localTemp, remotePath);
    await this.exec(`chmod 700 ${shellEscape(remotePath)} && ${shellEscape(remotePath)}`);
  }

  async copyTo(localPath: string, remotePath: string): Promise<void> {
    this.logger.info(`scp ${localPath} -> ${this.host}:${remotePath}`);
    await run([
      "scp",
      "-i",
      this.keyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      localPath,
      `${this.user}@${this.host}:${remotePath}`
    ]);
  }

  async read(remotePath: string): Promise<string> {
    return await this.exec(`cat ${shellEscape(remotePath)}`);
  }

  async write(remotePath: string, content: string, mode = "600"): Promise<void> {
    const localTemp = join(dirname(this.logger.path), basename(remotePath));
    writeFileSync(localTemp, content, "utf8");
    await this.copyTo(localTemp, remotePath);
    await this.exec(`chmod ${mode} ${shellEscape(remotePath)}`);
  }

  async uploadKeypair(privateKeyPath: string, publicKeyPath: string, remotePrivateKeyPath: string): Promise<void> {
    await this.copyTo(privateKeyPath, remotePrivateKeyPath);
    await this.exec(`chmod 600 ${shellEscape(remotePrivateKeyPath)}`);
    await this.copyTo(publicKeyPath, `${remotePrivateKeyPath}.pub`);
    await this.exec(`chmod 644 ${shellEscape(`${remotePrivateKeyPath}.pub`)}`);
  }

  async archive(remotePaths: string[], localPath: string): Promise<void> {
    const remoteTar = `/tmp/${basename(localPath)}.tar.gz`;
    await this.exec(`
      patterns=(${remotePaths.map((path) => shellEscape(path)).join(" ")})
      paths=()
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
        tar -czf ${shellEscape(remoteTar)} "\${paths[@]}"
      fi
    `);
    await run([
      "scp",
      "-i",
      this.keyPath,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      `${this.user}@${this.host}:${remoteTar}`,
      localPath
    ]);
    await this.exec(`rm -f ${shellEscape(remoteTar)}`);
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
