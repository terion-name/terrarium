import { spawn } from "node:child_process";

export type CommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function renderCommandFailure(cmd: string[], result: CommandResult): string {
  const parts = [`command failed (${result.exitCode}): ${cmd.join(" ")}`];
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

/**
 * Runs a command as argv, captures stdout/stderr, and never throws on non-zero exit.
 *
 * The harness uses this as the lowest-level primitive so every provider,
 * remote helper, and assertion can decide whether a failure is expected or fatal.
 */
export async function runAllowFailure(cmd: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const proc = spawn(cmd[0] ?? "", cmd.slice(1), {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"]
    });

    let settled = false;
    let timedOut = false;
    let timeout: Timer | undefined;
    let killTimer: Timer | undefined;

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    proc.on("error", (error) => {
      finish({
        exitCode: 127,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: [Buffer.concat(stderr).toString("utf8"), error.message].filter(Boolean).join("\n")
      });
    });
    proc.on("close", (code, signal) => {
      const stderrText = Buffer.concat(stderr).toString("utf8");
      finish({
        exitCode: code ?? (signal ? 128 + signalNumber(signal) : 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: timedOut ? `${stderrText}${stderrText ? "\n" : ""}command timed out after ${options.timeoutMs}ms` : stderrText
      });
    });

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
        finish({
          exitCode: 124,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}${stderr.length > 0 ? "\n" : ""}command timed out after ${options.timeoutMs}ms`
        });
      }, options.timeoutMs);
    }

    if (options.stdin !== undefined) {
      proc.stdin?.end(options.stdin);
    }
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const signals: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15
  };
  return signals[signal] ?? 1;
}

/** Runs a command and throws with a rendered message when it exits non-zero. */
export async function run(cmd: string[], options: CommandOptions = {}): Promise<string> {
  const result = await runAllowFailure(cmd, options);
  if (result.exitCode !== 0) {
    throw new Error(renderCommandFailure(cmd, result));
  }
  return result.stdout;
}

/** Runs an interactive command with inherited stdio. */
export async function runInteractive(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`command failed: ${cmd.join(" ")}`);
  }
}

/** Escapes a string for safe interpolation into remote shell snippets. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
