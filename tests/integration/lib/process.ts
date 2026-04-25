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
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });

  let timedOut = false;
  let killTimer: Timer | undefined;
  const timeout =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          killTimer = setTimeout(() => proc.kill("SIGKILL"), 2000);
        }, options.timeoutMs)
      : undefined;

  if (options.stdin !== undefined) {
    proc.stdin?.write(options.stdin);
    proc.stdin?.end();
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);

  if (timeout) {
    clearTimeout(timeout);
  }
  if (killTimer) {
    clearTimeout(killTimer);
  }

  return {
    exitCode,
    stdout,
    stderr: timedOut ? `${stderr}${stderr ? "\n" : ""}command timed out after ${options.timeoutMs}ms` : stderr
  };
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
