import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse } from "yaml";

export const DEFAULT_CONFIG_PATH = "/etc/terrarium/config.yaml";
export const TERRARIUM_CONFIG_PROJECT = process.env.TERRARIUM_CONFIG_PROJECT ?? "terrarium-system";
export const TERRARIUM_CONFIG_KEY = process.env.TERRARIUM_CONFIG_KEY ?? "user.terrarium.config_b64";
const DEFAULT_LXD_SOCKET_PATHS = ["/var/snap/lxd/common/lxd/unix.socket", "/var/lib/lxd/unix.socket"];

type ConfigBackend = "auto" | "file" | "lxd-dqlite";

type LxcResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
};

type WriteConfigOptions = {
  requireClusterStore?: boolean;
  localExport?: boolean;
};

function configuredBackend(): ConfigBackend {
  const raw = (process.env.TERRARIUM_CONFIG_BACKEND ?? "auto").trim();
  if (raw === "auto" || raw === "file" || raw === "lxd-dqlite") {
    return raw;
  }
  throw new Error(`TERRARIUM_CONFIG_BACKEND must be auto, file, or lxd-dqlite`);
}

function canonicalConfigPath(): string {
  return process.env.TERRARIUM_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
}

function shouldUseClusterStore(path: string): boolean {
  return path === canonicalConfigPath();
}

function lxcBinary(): string {
  const configured = process.env.TERRARIUM_LXC_BIN;
  if (configured) {
    return configured;
  }
  const fromPath = Bun.which("lxc");
  if (fromPath) {
    return fromPath;
  }
  return "/snap/bin/lxc";
}

function curlBinary(): string {
  const configured = process.env.TERRARIUM_CURL_BIN;
  if (configured) {
    return configured;
  }
  const fromPath = Bun.which("curl");
  if (fromPath) {
    return fromPath;
  }
  return "/usr/bin/curl";
}

function lxdSocketPath(): string {
  const configured = process.env.TERRARIUM_LXD_SOCKET;
  if (configured) {
    return configured;
  }
  const existing = DEFAULT_LXD_SOCKET_PATHS.find((path) => existsSync(path));
  if (existing) {
    return existing;
  }
  return DEFAULT_LXD_SOCKET_PATHS[0];
}

function runLxc(args: string[]): LxcResult {
  const binary = lxcBinary();
  if (!existsSync(binary) && binary.includes("/")) {
    return {
      ok: false,
      stdout: "",
      stderr: `missing lxc binary: ${binary}`,
      status: null
    };
  }

  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    timeout: 15_000
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    status: result.status
  };
}

function patchLxdProjectConfig(config: Record<string, string>): LxcResult {
  const binary = curlBinary();
  if (!existsSync(binary) && binary.includes("/")) {
    return {
      ok: false,
      stdout: "",
      stderr: `missing curl binary: ${binary}`,
      status: null
    };
  }

  const body = JSON.stringify({ config });
  const result = spawnSync(
    binary,
    [
      "-fsS",
      "--unix-socket",
      lxdSocketPath(),
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      "-X",
      "PATCH",
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
      `http://lxd/1.0/projects/${encodeURIComponent(TERRARIUM_CONFIG_PROJECT)}`
    ],
    {
      encoding: "utf8",
      input: body,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 15_000
    }
  );

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    status: result.status
  };
}

function ensureTerrariumProject(): void {
  const show = runLxc(["project", "show", TERRARIUM_CONFIG_PROJECT]);
  if (show.ok) {
    return;
  }

  const create = runLxc(["project", "create", TERRARIUM_CONFIG_PROJECT]);
  if (!create.ok) {
    const details = (create.stderr || show.stderr || "unknown LXD error").trim();
    throw new Error(`failed to create LXD project ${TERRARIUM_CONFIG_PROJECT}: ${details}`);
  }
}

function readClusterConfigDocument(): string | null {
  const result = runLxc(["project", "get", TERRARIUM_CONFIG_PROJECT, TERRARIUM_CONFIG_KEY]);
  if (!result.ok) {
    return null;
  }

  const encoded = result.stdout.trim();
  if (!encoded) {
    return null;
  }

  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function writeClusterConfigDocument(content: string): void {
  ensureTerrariumProject();
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const result = patchLxdProjectConfig({ [TERRARIUM_CONFIG_KEY]: encoded });
  if (!result.ok) {
    const details = (result.stderr || "unknown LXD error").trim();
    throw new Error(`failed to write Terrarium config to LXD dqlite store: ${details}`);
  }
}

export function readConfigDocument(path: string, _prefix: string): string {
  const backend = configuredBackend();
  if (backend !== "file" && shouldUseClusterStore(path)) {
    const clusterDocument = readClusterConfigDocument();
    if (clusterDocument !== null) {
      return clusterDocument;
    }
    if (backend === "lxd-dqlite") {
      throw new Error("Terrarium config was not found in the LXD dqlite store");
    }
  }

  if (!existsSync(path)) {
    throw new Error(`missing file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export function readConfigYaml<T>(path: string, prefix: string): T {
  return (parse(readConfigDocument(path, prefix)) ?? {}) as T;
}

export function hasConfigDocument(path: string, prefix: string): boolean {
  try {
    readConfigDocument(path, prefix);
    return true;
  } catch {
    return false;
  }
}

export function removeConfigExport(path: string): void {
  rmSync(path, { force: true });
}

export function writeConfigDocument(path: string, content: string, options: WriteConfigOptions = {}): void {
  const backend = configuredBackend();
  const syncCluster = backend !== "file" && shouldUseClusterStore(path);
  const writeLocalExport = !syncCluster || options.localExport === true || (!options.requireClusterStore && backend !== "lxd-dqlite");

  if (syncCluster && (options.requireClusterStore || backend === "lxd-dqlite")) {
    writeClusterConfigDocument(content);
    if (!writeLocalExport) {
      removeConfigExport(path);
      return;
    }
  }

  if (writeLocalExport) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
    writeFileSync(path, content, "utf8");
    chmodSync(path, 0o600);
  }

  if (!syncCluster || options.requireClusterStore || backend === "lxd-dqlite") {
    return;
  }

  try {
    writeClusterConfigDocument(content);
  } catch {
    // In auto mode the local file remains the bootstrap/recovery fallback until
    // LXD is initialized and the dqlite-backed store exists.
  }
}

export function importConfigFileToClusterStore(path: string, _prefix: string): void {
  if (!existsSync(path)) {
    throw new Error(`missing file: ${path}`);
  }
  writeClusterConfigDocument(readFileSync(path, "utf8"));
}

export function exportClusterStoreToConfigFile(path: string, prefix: string): boolean {
  const clusterDocument = readClusterConfigDocument();
  if (clusterDocument === null) {
    return false;
  }
  writeConfigDocument(path, clusterDocument, { requireClusterStore: false, localExport: true });
  return true;
}

export function configStoreSummary(path: string): string {
  if (configuredBackend() === "file" || !shouldUseClusterStore(path)) {
    return "file";
  }
  return readClusterConfigDocument() === null ? "file fallback" : `LXD dqlite project ${TERRARIUM_CONFIG_PROJECT}`;
}
