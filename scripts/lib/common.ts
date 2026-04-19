import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";

export type JsonRecord = Record<string, unknown>;

/** Prints a prefixed fatal error and exits the current process immediately. */
export function fail(prefix: string, message: string): never {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

/** Verifies that a required external command is available on the current PATH. */
export function ensureCommand(name: string, prefix: string): void {
  if (!Bun.which(name)) {
    fail(prefix, `missing required command: ${name}`);
  }
}

/** Reads a YAML file and parses it into the requested object shape. */
export function readYamlFile<T>(path: string, prefix: string): T {
  if (!existsSync(path)) {
    fail(prefix, `missing file: ${path}`);
  }
  return (parse(readFileSync(path, "utf8")) ?? {}) as T;
}

/**
 * Atomically writes a file only when the content actually changed.
 *
 * This keeps configuration updates idempotent and avoids unnecessary service
 * restarts triggered by no-op file rewrites.
 */
export function writeIfChanged(path: string, content: string): boolean {
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) {
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, path);
  return true;
}

/** Writes a pretty-printed JSON file with a trailing newline. */
export function writeJsonFile(path: string, value: unknown): void {
  writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads JSON from disk or returns a caller-provided fallback value. */
export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Stringifies arbitrary values into YAML using the repo’s standard serializer. */
export function yamlStringify(value: unknown): string {
  return stringify(value);
}

type CommandOptions = { cwd?: string; stdin?: string | Uint8Array; env?: Record<string, string> };

/**
 * Runs a command through Bun’s shell wrapper with consistent quiet/no-throw semantics.
 *
 * Higher-level helpers build on this so the rest of the codebase can choose
 * between fail-fast behavior and explicit exit-code handling.
 */
async function shellCommand(cmd: string[], options: CommandOptions = {}) {
  const proc = $`${cmd}`.quiet().nothrow();
  if (options.cwd) {
    proc.cwd(options.cwd);
  }
  if (options.env) {
    proc.env(options.env);
  }
  if (options.stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin);
    await writer.close();
  }
  return await proc;
}

/** Runs a command and returns stdout, failing the process if it exits non-zero. */
export async function runText(cmd: string[], prefix: string, options: CommandOptions = {}): Promise<string> {
  const proc = await shellCommand(cmd, options);
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    const rendered = stderr || `command failed: ${cmd.join(" ")}`;
    fail(prefix, rendered);
  }
  return proc.stdout.toString();
}

/** Runs a command and parses its stdout as JSON. */
export async function runJson<T>(cmd: string[], prefix: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<T> {
  const stdout = await runText(cmd, prefix, options);
  return JSON.parse(stdout || "null") as T;
}

/** Runs a command and returns stdout, stderr, and exit code without failing automatically. */
export async function runAllowFailure(
  cmd: string[],
  options: CommandOptions = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = await shellCommand(cmd, options);
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

/** Executes a full shell command string through `bash -lc`. */
export async function runShell(command: string, prefix: string, options: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  await runText(["bash", "-lc", command], prefix, options);
}

/** Runs a subprocess with inherited stdio for fully interactive flows. */
export async function runInteractive(cmd: string[], prefix: string, options: { cwd?: string } = {}): Promise<void> {
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    fail(prefix, `command failed: ${cmd.join(" ")}`);
  }
}

/** Escapes a shell argument for safe interpolation into ad-hoc shell strings. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** Loads the canonical Terrarium YAML config file. */
export function loadConfig(path: string, prefix: string): Record<string, unknown> {
  return readYamlFile<Record<string, unknown>>(path, prefix);
}

/** Resolves a dotted configuration path from a YAML-backed config object. */
export function configValue(config: Record<string, unknown>, key: string): unknown {
  let value: unknown = config;
  for (const part of key.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value)) {
      return "";
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value ?? "";
}

/** Resolves a config value as a string with a fallback for empty or missing values. */
export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = configValue(config, key);
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

/** Resolves a config value as a boolean using Terrarium’s accepted truthy spellings. */
export function configBoolean(config: Record<string, unknown>, key: string): boolean {
  const value = configValue(config, key);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

/** Creates a new temporary directory using the OS temp root and a caller prefix. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Removes a path recursively and ignores missing-path errors. */
export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
