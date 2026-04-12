import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";

export type JsonRecord = Record<string, unknown>;

export function fail(prefix: string, message: string): never {
  console.error(`${prefix}: ${message}`);
  process.exit(1);
}

export function ensureCommand(name: string, prefix: string): void {
  if (!Bun.which(name)) {
    fail(prefix, `missing required command: ${name}`);
  }
}

export function readYamlFile<T>(path: string, prefix: string): T {
  if (!existsSync(path)) {
    fail(prefix, `missing file: ${path}`);
  }
  return (parse(readFileSync(path, "utf8")) ?? {}) as T;
}

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

export function writeJsonFile(path: string, value: unknown): void {
  writeIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function yamlStringify(value: unknown): string {
  return stringify(value);
}

type CommandOptions = { cwd?: string; stdin?: string | Uint8Array };

export async function runText(cmd: string[], prefix: string, options: CommandOptions = {}): Promise<string> {
  const proc = await $({ cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe" })`${cmd}`.nothrow().quiet();
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    const rendered = stderr || `command failed: ${cmd.join(" ")}`;
    fail(prefix, rendered);
  }
  return proc.stdout.toString();
}

export async function runJson<T>(cmd: string[], prefix: string, options: { cwd?: string } = {}): Promise<T> {
  const stdout = await runText(cmd, prefix, options);
  return JSON.parse(stdout || "null") as T;
}

export async function runAllowFailure(
  cmd: string[],
  options: CommandOptions = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = await $({ cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe" })`${cmd}`.nothrow().quiet();
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString()
  };
}

export async function runShell(command: string, prefix: string, cwd?: string): Promise<void> {
  await runText(["bash", "-lc", command], prefix, { cwd });
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function loadConfig(path: string, prefix: string): Record<string, unknown> {
  return readYamlFile<Record<string, unknown>>(path, prefix);
}

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

export function configString(config: Record<string, unknown>, key: string, fallback = ""): string {
  const value = configValue(config, key);
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function configBoolean(config: Record<string, unknown>, key: string): boolean {
  const value = configValue(config, key);
  return value === true || value === "true";
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
