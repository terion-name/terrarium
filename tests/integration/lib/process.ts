import { $ } from "bun";

export type CommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

$.throws(false);

/**
 * Runs a command as argv, captures stdout/stderr, and never throws on non-zero exit.
 *
 * The harness uses this as the lowest-level primitive so every provider,
 * remote helper, and assertion can decide whether a failure is expected or fatal.
 */
export async function runAllowFailure(cmd: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const proc = $`${cmd}`.quiet().nothrow();
  if (options.cwd) {
    proc.cwd(options.cwd);
  }
  if (options.env) {
    proc.env(options.env);
  }
  if (options.stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  const result = await proc;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
}

/** Runs a command and throws with a rendered message when it exits non-zero. */
export async function run(cmd: string[], options: CommandOptions = {}): Promise<string> {
  const result = await runAllowFailure(cmd, options);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `command failed: ${cmd.join(" ")}`);
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
