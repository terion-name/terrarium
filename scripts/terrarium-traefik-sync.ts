import { createHash } from "node:crypto";
import { URL } from "node:url";
import { dirname, join } from "node:path";
import { chownSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged, writeJsonFile, yamlStringify } from "./lib/common";

const PREFIX = "terrariumctl proxy sync";
const DEFAULT_CONFIG_PATH = "/etc/terrarium/config.yaml";
const STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
const DYNAMIC_CONFIG_PATH = "/etc/traefik/dynamic/terrarium-lxc.yml";
const UFW_STATE_PATH = "/var/lib/terrarium/traefik-ufw-state.json";
const OAUTH2_PROXY_COOKIE_SECRET_PATH = "/etc/terrarium/secrets/oauth2_proxy_cookie_secret";
const ROUTE_AUTH_DIR = "/var/lib/terrarium/oauth2-proxy-routes";
const ROUTE_AUTH_COMPOSE_PATH = `${ROUTE_AUTH_DIR}/docker-compose.yml`;
const ROUTE_AUTH_BASE_PORT = 4181;
const DEFAULT_OAUTH2_PROXY_IMAGE =
  "ghcr.io/terion-name/terrarium-dhi-oauth2-proxy:7.15.2-debian13@sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const OAUTH2_PROXY_UID = 65532;
const OAUTH2_PROXY_GID = 65532;
const ROUTE_AUTH_READY_ATTEMPTS = 12;
const ROUTE_AUTH_READY_INTERVAL_MS = 1000;
const DEFAULT_ZITADEL_INSTANCE_NAME = "terrarium-idp";
const ZITADEL_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
const ZITADEL_BOOTSTRAP_DIR = "/var/lib/terrarium/zitadel/bootstrap";
const SYSTEM_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const CONTAINER_CA_BUNDLE_PATH = "/etc/ssl/certs/terrarium-ca-certificates.crt";
const ZITADEL_ROUTES_APP_NAME = "terrarium-routes";
const ZITADEL_WAIT_ATTEMPTS = 12;
const ZITADEL_WAIT_INTERVAL_MS = 3000;
const ZITADEL_HTTP_STATUS_MARKER = "__terrarium_http_status__:";
const PROXY_BACKEND_STATE_PATH = "/var/lib/terrarium/proxy-backends.json";
const PROXY_BACKEND_DEVICE_PREFIX = "terrarium-proxy";
const PROXY_BACKEND_BASE_PORT = 18081;
const PROXY_BACKEND_MAX_PORT = 18999;
const PROXY_SYNC_LOCK_DIR = "/run/terrarium/proxy-sync.lock";
const PROXY_SYNC_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const PROXY_SYNC_LOCK_STALE_MS = 60 * 60 * 1000;
const PROXY_SYNC_LOCK_POLL_MS = 500;

type LxcAddress = {
  family?: string;
  scope?: string;
  address?: string;
};

type LxcNetwork = {
  addresses?: LxcAddress[];
};

type LxcInstance = {
  name?: string;
  config?: Record<string, string>;
  state?: {
    network?: Record<string, LxcNetwork>;
  };
};

type LxcState = {
  network?: Record<string, LxcNetwork>;
};

type DesiredPort = {
  proto: "tcp" | "udp";
  port: number;
};

type AuthSpec = {
  enabled: boolean;
  groups: string[];
};

type HttpProxyItem = {
  kind: "http";
  scheme: "http" | "https";
  host: string;
  path: string;
  targetPort: number;
  auth: AuthSpec;
};

type TransportProxyItem = { kind: "tcp" | "udp"; hostPort: number; containerPort: number };

type ProxyBackendProtocol = "tcp" | "udp";

type ProxyBackendSpec = {
  key: string;
  containerName: string;
  proto: ProxyBackendProtocol;
  targetPort: number;
  deviceName: string;
};

type ProxyBackendStateEntry = ProxyBackendSpec & {
  hostPort: number;
};

export type ProxyBackendTarget = {
  address: string;
  port: number;
};

type RouteAuthProfile = {
  key: string;
  host: string;
  groups: string[];
  port: number;
  proxyPrefix: string;
  callbackPath: string;
  middlewareName: string;
  serviceName: string;
  containerName: string;
};

type RouteAuthComposeArtifacts = {
  composeYaml: string;
  profileConfigs: Record<string, string>;
};

type RouteAuthComposeRender = {
  composeYaml: string;
  changed: boolean;
};

type CommandResult = Awaited<ReturnType<typeof runAllowFailure>>;

type ProxySyncErrorGroups = {
  dynamicErrors?: string[];
  ufwErrors?: string[];
  backendErrors?: string[];
  localRouteClientErrors?: string[];
  routeAuthErrors?: string[];
};

type ZitadelProject = { id?: string; name?: string };
type ZitadelApp = { id?: string; name?: string };
type ProxySyncLockOwner = {
  token?: string;
  pid?: number;
  acquiredAt?: number;
};

function compactCommandOutput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "<empty>";
  }
  return trimmed.length > 1200 ? `${trimmed.slice(0, 1200)}...` : trimmed;
}

function formatCommandResult(result: Pick<CommandResult, "stdout" | "stderr">): string {
  return `last stderr/stdout: stderr=${JSON.stringify(compactCommandOutput(result.stderr))} stdout=${JSON.stringify(compactCommandOutput(result.stdout))}`;
}

function formatRouteAuthProfile(profile: Pick<RouteAuthProfile, "host" | "groups" | "port">): string {
  const groups = profile.groups.length > 0 ? profile.groups.join(",") : "<none>";
  return `host=${profile.host} groups=${groups} port=${profile.port}`;
}

export function formatRouteAuthReadinessError(
  profile: Pick<RouteAuthProfile, "host" | "groups" | "port">,
  endpoint: string,
  result: Pick<CommandResult, "stdout" | "stderr">
): string {
  return `route auth listener failed readiness probe for ${formatRouteAuthProfile(profile)} at ${endpoint}: ${formatCommandResult(result)}`;
}

function formatRouteAuthCommandFailure(message: string, result: Pick<CommandResult, "stdout" | "stderr">): string {
  return `${message}: ${formatCommandResult(result)}`;
}

function appendLabeledErrors(output: string[], label: string, errors: string[] | undefined): void {
  for (const error of errors ?? []) {
    output.push(`${label}: ${error}`);
  }
}

export function buildProxySyncFailureMessage(errorGroups: ProxySyncErrorGroups): string | null {
  const errors: string[] = [];
  appendLabeledErrors(errors, "dynamic config", errorGroups.dynamicErrors);
  appendLabeledErrors(errors, "ufw", errorGroups.ufwErrors);
  appendLabeledErrors(errors, "backend", errorGroups.backendErrors);
  appendLabeledErrors(errors, "local route client", errorGroups.localRouteClientErrors);
  appendLabeledErrors(errors, "route auth", errorGroups.routeAuthErrors);

  if (errors.length === 0) {
    return null;
  }

  return `proxy sync failed:\n${errors.map((error) => `- ${error}`).join("\n")}`;
}

export function assertProxySyncSucceeded(errorGroups: ProxySyncErrorGroups): void {
  const message = buildProxySyncFailureMessage(errorGroups);
  if (message) {
    throw new Error(message);
  }
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

function readProxySyncLockOwner(): ProxySyncLockOwner {
  try {
    return JSON.parse(readFileSync(join(PROXY_SYNC_LOCK_DIR, "owner.json"), "utf8")) as ProxySyncLockOwner;
  } catch {
    return {};
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function proxySyncLockIsStale(owner: ProxySyncLockOwner, now = Date.now()): boolean {
  if (typeof owner.pid === "number" && owner.pid > 0 && !processIsAlive(owner.pid)) {
    return true;
  }
  if (typeof owner.acquiredAt === "number" && now - owner.acquiredAt > PROXY_SYNC_LOCK_STALE_MS) {
    return true;
  }
  return false;
}

async function acquireProxySyncLock(): Promise<() => void> {
  mkdirSync(dirname(PROXY_SYNC_LOCK_DIR), { recursive: true, mode: 0o755 });
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + PROXY_SYNC_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      mkdirSync(PROXY_SYNC_LOCK_DIR, { mode: 0o700 });
      writeFileSync(
        join(PROXY_SYNC_LOCK_DIR, "owner.json"),
        `${JSON.stringify({ token, pid: process.pid, acquiredAt: Date.now() }, null, 2)}\n`,
        { mode: 0o600 }
      );
      return () => {
        const owner = readProxySyncLockOwner();
        if (owner.token === token) {
          rmSync(PROXY_SYNC_LOCK_DIR, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const owner = readProxySyncLockOwner();
    if (proxySyncLockIsStale(owner)) {
      rmSync(PROXY_SYNC_LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    await Bun.sleep(PROXY_SYNC_LOCK_POLL_MS);
  }

  const owner = readProxySyncLockOwner();
  throw new Error(`timed out waiting for proxy sync lock at ${PROXY_SYNC_LOCK_DIR}; current owner: ${JSON.stringify(owner)}`);
}

async function withProxySyncLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireProxySyncLock();
  try {
    return await run();
  } finally {
    release();
  }
}

function isRetriableZitadelApiError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "failed to connect",
    "connection refused",
    "empty reply from server",
    "timed out",
    "timeout was reached",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "404 page not found",
    "http 400",
    "http 404",
    "http 502",
    "http 503",
    "http 504"
  ].some((needle) => lowered.includes(needle));
}

export function parseZitadelHttpOutput(raw: string): { status: number; body: string } {
  const markerIndex = raw.lastIndexOf(ZITADEL_HTTP_STATUS_MARKER);
  if (markerIndex === -1) {
    throw new Error("ZITADEL API response did not include an HTTP status marker");
  }

  const body = raw.slice(0, markerIndex).replace(/\n$/, "");
  const statusRaw = raw.slice(markerIndex + ZITADEL_HTTP_STATUS_MARKER.length).trim();
  const status = Number(statusRaw);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`ZITADEL API response included invalid HTTP status: ${statusRaw || "<empty>"}`);
  }
  return { status, body };
}

function formatZitadelHttpFailure(method: string, path: string, status: number, body: string): string {
  return `ZITADEL API ${method} ${path} returned HTTP ${status}: ${compactCommandOutput(body)}`;
}

export function isZitadelNoChangesResponse(status: number, body: string): boolean {
  if (status !== 400) {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    return parsed.code === 9 && typeof parsed.message === "string" && parsed.message.toLowerCase().includes("no changes");
  } catch {
    return body.toLowerCase().includes("no changes");
  }
}

/**
 * Extracts a JSON document from command output that may contain leading chatter.
 *
 * Fresh Ubuntu hosts can emit bootstrap messages such as `Installing LXD...`
 * before the actual JSON payload appears. Traefik sync should tolerate that
 * during first install instead of aborting the whole converge.
 */
function parseJsonFromOutput<T>(raw: string): T | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  for (const marker of ["[", "{"]) {
    const index = trimmed.indexOf(marker);
    if (index === -1) {
      continue;
    }
    try {
      return JSON.parse(trimmed.slice(index)) as T;
    } catch {
      continue;
    }
  }

  return null;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "route";
}

function splitProxyItems(rawValue: string): string[] {
  const normalized = rawValue.replaceAll("\n", ",");
  const items: string[] = [];
  let current = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char !== ",") {
      current += char;
      continue;
    }

    const remainder = normalized.slice(index + 1).trimStart();
    if (/^(https?:\/\/|tcp:\/\/|udp:\/\/)/.test(remainder)) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    items.push(current.trim());
  }

  return items;
}

function findIpv4(instance: LxcInstance): string | null {
  for (const iface of Object.values(instance.state?.network ?? {})) {
    for (const address of iface.addresses ?? []) {
      if (address.family === "inet" && address.scope === "global" && address.address) {
        return address.address;
      }
    }
  }
  return null;
}

function parseAuthSuffix(item: string): { route: string; auth: AuthSpec } {
  const authIndex = item.lastIndexOf("@auth");
  if (authIndex === -1) {
    return { route: item, auth: { enabled: false, groups: [] } };
  }

  const suffix = item.slice(authIndex);
  if (!/^@auth(?::[A-Za-z0-9._,-]+)?$/.test(suffix)) {
    throw new Error(`unsupported auth suffix: ${suffix}`);
  }

  const groups = suffix.includes(":")
    ? suffix
        .slice(suffix.indexOf(":") + 1)
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean)
    : [];

  return {
    route: item.slice(0, authIndex),
    auth: {
      enabled: true,
      groups: [...new Set(groups)].sort()
    }
  };
}

function parseProxyItem(item: string): HttpProxyItem | TransportProxyItem {
  const { route, auth } = parseAuthSuffix(item);

  if (route.startsWith("http://") || route.startsWith("https://")) {
    const parsed = new URL(route);
    if (parsed.search || parsed.hash) {
      throw new Error(`query strings and fragments are not supported: ${item}`);
    }
    return {
      kind: "http",
      scheme: parsed.protocol.replace(":", "") as "http" | "https",
      host: parsed.hostname,
      path: parsed.pathname || "/",
      targetPort: parsed.port ? Number(parsed.port) : 80,
      auth
    };
  }

  if (auth.enabled) {
    throw new Error("auth protection is supported only for http:// and https:// routes");
  }

  const match = /^(tcp|udp):\/\/([0-9]{1,5}):([0-9]{1,5})$/.exec(route);
  if (!match) {
    throw new Error(`unsupported proxy value: ${item}`);
  }

  return {
    kind: match[1] as "tcp" | "udp",
    hostPort: Number(match[2]),
    containerPort: Number(match[3])
  };
}

function zitadelCurlBase(authDomain: string, pat: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string): string[] {
  const cmd = [
    "curl",
    "-sS",
    "--noproxy",
    "*",
    "--resolve",
    `${authDomain}:443:127.0.0.1`,
    "--connect-timeout",
    "10",
    "--max-time",
    "20",
    "--write-out",
    `\n${ZITADEL_HTTP_STATUS_MARKER}%{http_code}`
  ];
  if (existsSync(SYSTEM_CA_BUNDLE_PATH)) {
    cmd.push("--cacert", SYSTEM_CA_BUNDLE_PATH);
  }
  cmd.push("-X", method, "-H", `Authorization: Bearer ${pat}`, "-H", "Content-Type: application/json", url);
  return cmd;
}

async function lxcInstanceExists(instanceName: string): Promise<boolean> {
  if (!instanceName) {
    return false;
  }
  const result = await runAllowFailure(["lxc", "info", instanceName]);
  return result.exitCode === 0;
}

async function readLocalZitadelPat(config: Record<string, unknown>): Promise<{ pat?: string; error?: string }> {
  const instanceName = configString(config, "terrarium_zitadel_instance_name", DEFAULT_ZITADEL_INSTANCE_NAME);
  const bootstrapDir = configString(config, "terrarium_zitadel_bootstrap_dir") || ZITADEL_BOOTSTRAP_DIR;
  const patPath = `${bootstrapDir}/admin-sa.pat`;

  if (await lxcInstanceExists(instanceName)) {
    const result = await runAllowFailure(["lxc", "exec", instanceName, "--", "cat", patPath]);
    if (result.exitCode !== 0) {
      return { error: `route auth local IDP sync requires ${patPath} inside ${instanceName}` };
    }
    return { pat: result.stdout.trim() };
  }

  if (!existsSync(patPath)) {
    return { error: `route auth local IDP sync requires ${patPath}` };
  }
  return { pat: readFileSync(patPath, "utf8").trim() };
}

async function zitadelApi<T>(
  authDomain: string,
  pat: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const cmd = zitadelCurlBase(authDomain, pat, method, `https://${authDomain}${path}`);
  if (body !== undefined && method !== "GET") {
    cmd.push("-d", JSON.stringify(body));
  }

  let lastError = "";
  for (let attempt = 0; attempt < ZITADEL_WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(cmd);
    if (result.exitCode === 0) {
      try {
        const response = parseZitadelHttpOutput(result.stdout);
        if (response.status >= 200 && response.status < 300) {
          return JSON.parse(response.body || "null") as T;
        }
        if (isZitadelNoChangesResponse(response.status, response.body)) {
          return JSON.parse(response.body || "null") as T;
        }
        lastError = formatZitadelHttpFailure(method, path, response.status, response.body);
      } catch (error) {
        lastError = String(error).replace(/^Error: /, "");
      }
    } else {
      lastError = result.stderr.trim() || result.stdout.trim() || `ZITADEL API ${method} ${path} failed`;
    }
    if (!isRetriableZitadelApiError(lastError)) {
      throw new Error(lastError);
    }
    await Bun.sleep(ZITADEL_WAIT_INTERVAL_MS);
  }

  throw new Error(`timed out waiting for ZITADEL API ${method} ${path}: ${lastError}`);
}

async function lookupZitadelProjectId(authDomain: string, pat: string, outputs: Record<string, { value?: string }>): Promise<string> {
  const outputValue = outputs.project_id?.value?.trim();
  if (outputValue) {
    return outputValue;
  }

  const projects = await zitadelApi<{ result?: ZitadelProject[] }>(authDomain, pat, "POST", "/management/v1/projects/_search", {});
  const project = (projects.result ?? []).find((entry) => entry.name === "Terrarium");
  if (!project?.id) {
    throw new Error("failed to find Terrarium project in ZITADEL");
  }
  return project.id;
}

async function lookupRoutesAppId(authDomain: string, pat: string, projectId: string): Promise<string> {
  const apps = await zitadelApi<{ result?: ZitadelApp[] }>(
    authDomain,
    pat,
    "POST",
    `/management/v1/projects/${projectId}/apps/_search`,
    {}
  );
  const app = (apps.result ?? []).find((entry) => entry.name === ZITADEL_ROUTES_APP_NAME);
  if (!app?.id) {
    throw new Error("failed to find terrarium-routes app in ZITADEL");
  }
  return app.id;
}

async function syncLocalRoutesClient(config: Record<string, unknown>, profiles: RouteAuthProfile[]): Promise<string[]> {
  if (configString(config, "terrarium_idp_mode") !== "local") {
    return [];
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  const manageDomain = configString(config, "terrarium_manage_domain");
  if (!authDomain || !manageDomain) {
    return ["route auth local IDP sync requires terrarium_auth_domain and terrarium_manage_domain"];
  }

  const { pat: adminPat = "", error } = await readLocalZitadelPat(config);
  if (error) {
    return [error];
  }
  if (!adminPat) {
    return ["route auth local IDP sync requires a non-empty bootstrap PAT"];
  }

  const outputs = readJsonFile<Record<string, { value?: string }>>(ZITADEL_OUTPUTS_PATH, {});

  try {
    const projectId = await lookupZitadelProjectId(authDomain, adminPat, outputs);
    const appId = await lookupRoutesAppId(authDomain, adminPat, projectId);
    const redirectUris =
      profiles.length > 0
        ? profiles.map((profile) => `https://${profile.host}${profile.callbackPath}`)
        : [`https://${manageDomain}/oauth2/app/callback`];
    const postLogoutRedirectUris = [...new Set([`https://${manageDomain}/`, ...profiles.map((profile) => `https://${profile.host}/`)])];

    await zitadelApi(
      authDomain,
      adminPat,
      "PUT",
      `/management/v1/projects/${projectId}/apps/${appId}/oidc_config`,
      {
        redirectUris,
        responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
        appType: "OIDC_APP_TYPE_WEB",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
        postLogoutRedirectUris,
        version: "OIDC_VERSION_1_0",
        devMode: false,
        accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
        accessTokenRoleAssertion: true,
        idTokenRoleAssertion: true,
        idTokenUserinfoAssertion: true,
        clockSkew: "0s",
        additionalOrigins: [],
        skipNativeAppSuccessPage: false,
        loginVersion: {
          loginV2: {
            baseUri: `https://${authDomain}/ui/v2/login/`
          }
        }
      }
    );
  } catch (error) {
    return [String(error).replace(/^Error: /, "")];
  }

  return [];
}

function loadUfwState(): DesiredPort[] {
  return readJsonFile<DesiredPort[]>(UFW_STATE_PATH, []);
}

async function enrichInstanceState(containers: LxcInstance[]): Promise<LxcInstance[]> {
  const enriched: LxcInstance[] = [];

  for (const container of containers) {
    if (container.state?.network || !container.name) {
      enriched.push(container);
      continue;
    }

    const response = await runAllowFailure(["timeout", "15s", "lxc", "query", `/1.0/instances/${container.name}/state`]);
    if (response.exitCode !== 0) {
      enriched.push(container);
      continue;
    }

    try {
      const state = JSON.parse(response.stdout || "{}") as LxcState;
      enriched.push({
        ...container,
        state
      });
    } catch {
      enriched.push(container);
    }
  }

  return enriched;
}

async function ensureUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runText(
    ["ufw", "allow", "proto", proto, "from", "any", "to", "any", "port", String(port), "comment", "terrarium-proxy"],
    PREFIX
  );
}

async function deleteUfwRule(proto: "tcp" | "udp", port: number): Promise<void> {
  await runAllowFailure(["bash", "-lc", `yes | ufw delete allow proto ${proto} from any to any port ${port} comment terrarium-proxy`]);
}

async function syncUfw(desiredPorts: DesiredPort[]): Promise<string[]> {
  if (!Bun.which("ufw")) {
    console.warn(`${PREFIX}: ufw not found; skipped firewall sync`);
    return [];
  }

  const previous = loadUfwState();
  const desiredSet = new Set(desiredPorts.map((item) => `${item.proto}:${item.port}`));
  const previousSet = new Set(previous.map((item) => `${item.proto}:${item.port}`));
  const applied = new Set(previousSet);
  const errors: string[] = [];

  for (const item of previousSet) {
    if (desiredSet.has(item)) {
      continue;
    }
    const [proto, port] = item.split(":");
    await deleteUfwRule(proto as "tcp" | "udp", Number(port));
    applied.delete(item);
  }

  for (const item of desiredSet) {
    if (previousSet.has(item)) {
      continue;
    }
    const [proto, port] = item.split(":");
    try {
      await ensureUfwRule(proto as "tcp" | "udp", Number(port));
      applied.add(item);
    } catch (error) {
      errors.push(`failed to add UFW rule ${proto}/${port}: ${String(error)}`);
    }
  }

  writeJsonFile(
    UFW_STATE_PATH,
    [...applied]
      .sort()
      .map((item) => {
        const [proto, port] = item.split(":");
        return { proto, port: Number(port) };
      })
  );

  return errors;
}

async function loadInstancesForProxySync(): Promise<LxcInstance[]> {
  const result = await runAllowFailure(["timeout", "15s", "lxc", "list", "-f", "json"]);
  if (result.exitCode !== 0) {
    throw new Error(`LXD is not ready; refusing to overwrite proxy configuration: ${compactCommandOutput(result.stderr || result.stdout)}`);
  }

  const parsed = parseJsonFromOutput<LxcInstance[]>(result.stdout);
  if (!parsed) {
    throw new Error(`LXD output was not valid JSON; refusing to overwrite proxy configuration: ${compactCommandOutput(result.stdout)}`);
  }

  return parsed;
}

function containersWithProxyLabels(containers: LxcInstance[]): LxcInstance[] {
  return containers.filter((container) => (container.config?.["user.proxy"]?.trim() ?? "").length > 0);
}

function proxyBackendKey(containerName: string, proto: ProxyBackendProtocol, targetPort: number): string {
  return `${containerName}:${proto}:${targetPort}`;
}

function proxyBackendDeviceName(key: string, proto: ProxyBackendProtocol, targetPort: number): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 10);
  return `${PROXY_BACKEND_DEVICE_PREFIX}-${proto}-${targetPort}-${hash}`;
}

function collectDesiredProxyBackendSpecs(containers: LxcInstance[]): ProxyBackendSpec[] {
  const specs = new Map<string, ProxyBackendSpec>();

  for (const container of containersWithProxyLabels(containers)) {
    if (!container.name) {
      continue;
    }

    for (const rawItem of splitProxyItems(container.config?.["user.proxy"] ?? "")) {
      let item: ReturnType<typeof parseProxyItem>;
      try {
        item = parseProxyItem(rawItem);
      } catch {
        continue;
      }

      const proto = item.kind === "http" ? "tcp" : item.kind;
      const targetPort = item.kind === "http" ? item.targetPort : item.containerPort;
      const key = proxyBackendKey(container.name, proto, targetPort);
      specs.set(key, {
        key,
        containerName: container.name,
        proto,
        targetPort,
        deviceName: proxyBackendDeviceName(key, proto, targetPort)
      });
    }
  }

  return [...specs.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function isProxyBackendStateEntry(value: unknown): value is ProxyBackendStateEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.key === "string" &&
    typeof entry.containerName === "string" &&
    (entry.proto === "tcp" || entry.proto === "udp") &&
    Number.isInteger(entry.targetPort) &&
    Number.isInteger(entry.hostPort) &&
    typeof entry.deviceName === "string"
  );
}

function loadProxyBackendState(): ProxyBackendStateEntry[] {
  const raw = readJsonFile<unknown>(PROXY_BACKEND_STATE_PATH, []);
  return Array.isArray(raw) ? raw.filter(isProxyBackendStateEntry) : [];
}

function allocateProxyBackendPort(usedPorts: Set<number>): number {
  for (let port = PROXY_BACKEND_BASE_PORT; port <= PROXY_BACKEND_MAX_PORT; port += 1) {
    if (!usedPorts.has(port)) {
      return port;
    }
  }
  throw new Error(`no free Terrarium proxy backend ports in ${PROXY_BACKEND_BASE_PORT}-${PROXY_BACKEND_MAX_PORT}`);
}

function backendListenAddress(entry: ProxyBackendStateEntry): string {
  return `${entry.proto}:127.0.0.1:${entry.hostPort}`;
}

function backendConnectAddress(entry: ProxyBackendStateEntry): string {
  return `${entry.proto}:127.0.0.1:${entry.targetPort}`;
}

function deviceMissing(output: string): boolean {
  const lowered = output.toLowerCase();
  return lowered.includes("not found") || lowered.includes("does not exist") || lowered.includes("doesn't exist");
}

async function readLxdProxyDeviceValue(containerName: string, deviceName: string, key: string): Promise<string | null> {
  const result = await runAllowFailure(["timeout", "15s", "lxc", "config", "device", "get", containerName, deviceName, key]);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim();
}

async function removeLxdProxyDevice(entry: ProxyBackendStateEntry): Promise<string | null> {
  const result = await runAllowFailure([
    "timeout",
    "30s",
    "lxc",
    "config",
    "device",
    "remove",
    entry.containerName,
    entry.deviceName
  ]);
  if (result.exitCode === 0 || deviceMissing(result.stderr || result.stdout)) {
    return null;
  }
  return `failed to remove stale LXD proxy device ${entry.containerName}/${entry.deviceName}: ${compactCommandOutput(result.stderr || result.stdout)}`;
}

async function ensureLxdProxyDevice(entry: ProxyBackendStateEntry): Promise<string | null> {
  const expectedListen = backendListenAddress(entry);
  const expectedConnect = backendConnectAddress(entry);
  const listen = await readLxdProxyDeviceValue(entry.containerName, entry.deviceName, "listen");
  const connect = await readLxdProxyDeviceValue(entry.containerName, entry.deviceName, "connect");
  if (listen === expectedListen && connect === expectedConnect) {
    return null;
  }

  if (listen !== null || connect !== null) {
    const removeError = await removeLxdProxyDevice(entry);
    if (removeError) {
      return removeError;
    }
  }

  const result = await runAllowFailure([
    "timeout",
    "30s",
    "lxc",
    "config",
    "device",
    "add",
    entry.containerName,
    entry.deviceName,
    "proxy",
    `listen=${expectedListen}`,
    `connect=${expectedConnect}`,
    "bind=host"
  ]);
  if (result.exitCode !== 0) {
    return `failed to add LXD proxy device ${entry.containerName}/${entry.deviceName}: ${compactCommandOutput(result.stderr || result.stdout)}`;
  }

  return null;
}

async function syncLxdProxyBackends(containers: LxcInstance[]): Promise<{ targets: Record<string, ProxyBackendTarget>; errors: string[] }> {
  const specs = collectDesiredProxyBackendSpecs(containers);
  const desiredKeys = new Set(specs.map((spec) => spec.key));
  const previous = loadProxyBackendState();
  const previousByKey = new Map<string, ProxyBackendStateEntry>();
  const errors: string[] = [];

  for (const entry of previous) {
    if (!previousByKey.has(entry.key)) {
      previousByKey.set(entry.key, entry);
    }
    if (!desiredKeys.has(entry.key)) {
      const removeError = await removeLxdProxyDevice(entry);
      if (removeError) {
        errors.push(removeError);
      }
    }
  }

  const usedPorts = new Set(
    previous
      .map((entry) => entry.hostPort)
      .filter((port) => Number.isInteger(port) && port >= PROXY_BACKEND_BASE_PORT && port <= PROXY_BACKEND_MAX_PORT)
  );
  const next: ProxyBackendStateEntry[] = [];

  for (const spec of specs) {
    const previousEntry = previousByKey.get(spec.key);
    let hostPort =
      previousEntry?.hostPort &&
      previousEntry.hostPort >= PROXY_BACKEND_BASE_PORT &&
      previousEntry.hostPort <= PROXY_BACKEND_MAX_PORT &&
      !next.some((entry) => entry.hostPort === previousEntry.hostPort)
        ? previousEntry.hostPort
        : undefined;
    if (!hostPort) {
      try {
        hostPort = allocateProxyBackendPort(usedPorts);
      } catch (error) {
        errors.push(`${spec.containerName}: ${String(error).replace(/^Error: /, "")}`);
        continue;
      }
    }
    usedPorts.add(hostPort);

    if (previousEntry && previousEntry.deviceName !== spec.deviceName) {
      const removeError = await removeLxdProxyDevice(previousEntry);
      if (removeError) {
        errors.push(removeError);
        continue;
      }
    }

    const entry: ProxyBackendStateEntry = { ...spec, hostPort };
    const deviceError = await ensureLxdProxyDevice(entry);
    if (deviceError) {
      errors.push(deviceError);
      continue;
    }
    next.push(entry);
  }

  if (errors.length === 0) {
    writeJsonFile(PROXY_BACKEND_STATE_PATH, next);
  }

  const targets = Object.fromEntries(
    next.map((entry) => [
      entry.key,
      {
        address: "127.0.0.1",
        port: entry.hostPort
      }
    ])
  );

  return { targets, errors };
}

function routeHostAllowedForManagedAuth(host: string, rootDomain: string, manageDomain: string): boolean {
  if (!rootDomain) {
    return host === manageDomain;
  }
  return host === rootDomain || host.endsWith(`.${rootDomain}`);
}

function normalizedRouteAuthGroups(groups: string[]): string[] {
  return [...new Set(groups)].sort();
}

function routeAuthProfileKey(host: string, groups: string[]): string {
  return `${host}\n${normalizedRouteAuthGroups(groups).join("\n")}`;
}

function routeAuthProfileSuffix(host: string, groups: string[]): string {
  const policy = groups.length > 0 ? groups.join("-") : "authenticated";
  const base = slugify(`${host}-${policy}`);
  const trimmed = base.length > 56 ? base.slice(0, 56).replace(/-+$/g, "") : base;
  const hash = createHash("sha256").update(routeAuthProfileKey(host, groups)).digest("hex").slice(0, 10);
  return `${trimmed || "route"}-${hash}`;
}

function routeAuthList(values: string[]): string {
  return `[ ${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")} ]`;
}

export function buildRouteAuthProfiles(containers: LxcInstance[], config: Record<string, unknown>): { profiles: RouteAuthProfile[]; errors: string[] } {
  const rootDomain = configString(config, "terrarium_root_domain");
  const manageDomain = configString(config, "terrarium_manage_domain");
  const profilePolicies = new Map<string, { host: string; groups: string[] }>();
  const errors: string[] = [];

  for (const container of containers) {
    const name = container.name ?? "unknown";
    const label = container.config?.["user.proxy"]?.trim() ?? "";
    if (!label) {
      continue;
    }

    for (const rawItem of splitProxyItems(label)) {
      let parsed: HttpProxyItem | TransportProxyItem;
      try {
        parsed = parseProxyItem(rawItem);
      } catch (error) {
        errors.push(`${name}: ${String(error).replace(/^Error: /, "")}`);
        continue;
      }

      if (parsed.kind !== "http" || !parsed.auth.enabled) {
        continue;
      }

      if (!routeHostAllowedForManagedAuth(parsed.host, rootDomain, manageDomain)) {
        errors.push(`${name}: auth-protected route host ${parsed.host} must be ${manageDomain} or a subdomain of ${rootDomain}`);
        continue;
      }

      const groups = normalizedRouteAuthGroups(parsed.auth.groups);
      profilePolicies.set(routeAuthProfileKey(parsed.host, groups), { host: parsed.host, groups });
    }
  }

  const profiles: RouteAuthProfile[] = [];
  const sortedPolicies = [...profilePolicies.values()].sort(
    (left, right) => left.host.localeCompare(right.host) || left.groups.join(",").localeCompare(right.groups.join(","))
  );
  for (const [index, policy] of sortedPolicies.entries()) {
    const suffix = routeAuthProfileSuffix(policy.host, policy.groups);
    const proxyPrefix = `/oauth2/route/${suffix}`;
    profiles.push({
      key: routeAuthProfileKey(policy.host, policy.groups),
      host: policy.host,
      groups: policy.groups,
      port: ROUTE_AUTH_BASE_PORT + index,
      proxyPrefix,
      callbackPath: `${proxyPrefix}/callback`,
      middlewareName: `lxc-auth-${suffix}`,
      serviceName: `oauth2-proxy-route-${suffix}`,
      containerName: `route-${suffix}`
    });
  }

  return { profiles, errors };
}

export function buildRouteAuthRedirectUris(routeLabels: string[], config: Record<string, unknown>): { redirectUris: string[]; errors: string[] } {
  const containers = routeLabels.map((label, index) => ({
    name: `route-auth-${index}`,
    config: {
      "user.proxy": label
    }
  }));
  const { profiles, errors } = buildRouteAuthProfiles(containers, config);
  return {
    redirectUris: profiles.map((profile) => `https://${profile.host}${profile.callbackPath}`),
    errors
  };
}

export function buildRouteAuthComposeArtifacts(
  config: Record<string, unknown>,
  profiles: RouteAuthProfile[],
  clientId: string,
  clientSecret: string,
  cookieSecret: string
): RouteAuthComposeArtifacts {
  const localIdp = configString(config, "terrarium_idp_mode") === "local";
  const localAuthDomain = configString(config, "terrarium_auth_domain");
  const issuer = localIdp && localAuthDomain ? `https://${localAuthDomain}` : configString(config, "terrarium_oidc_issuer");
  const oauth2ProxyImage = configString(config, "terrarium_oauth2_proxy_image", DEFAULT_OAUTH2_PROXY_IMAGE);
  const profileConfigs: Record<string, string> = {};

  const services = Object.fromEntries(
    profiles.map((profile) => {
      const cfgLines = [
        'provider = "oidc"',
        'provider_display_name = "Terrarium"',
        `http_address = "127.0.0.1:${profile.port}"`,
        `proxy_prefix = "${profile.proxyPrefix}"`,
        `redirect_url = "${profile.callbackPath}"`,
        `oidc_issuer_url = "${issuer}"`,
        'oidc_groups_claim = "groups"',
        `client_id = "${clientId}"`,
        `client_secret = "${clientSecret}"`,
        `cookie_secret = "${cookieSecret}"`,
        `cookie_name = "__Host-terrarium_route_${profile.containerName.replace(/^route-/, "")}"`,
        "cookie_secure = true",
        'cookie_path = "/"',
        `whitelist_domains = [ "${profile.host}" ]`,
        'email_domains = [ "*" ]',
        'upstreams = [ "static://202" ]',
        'scope = "openid profile email"',
        "reverse_proxy = true",
        'trusted_proxy_ips = [ "127.0.0.1/32", "::1/128" ]',
        'code_challenge_method = "S256"',
        "skip_provider_button = true",
        "set_xauthrequest = true",
        "pass_authorization_header = true",
        "pass_user_headers = true",
        "pass_access_token = false",
        "skip_jwt_bearer_tokens = true",
        "ssl_insecure_skip_verify = false"
      ];
      if (profile.groups.length > 0) {
        cfgLines.push(`allowed_groups = ${routeAuthList(profile.groups)}`);
      }
      profileConfigs[profile.containerName] = `${cfgLines.join("\n")}\n`;

      return [
        profile.containerName,
        {
          image: oauth2ProxyImage,
          user: `${OAUTH2_PROXY_UID}:${OAUTH2_PROXY_GID}`,
          network_mode: "host",
          restart: "unless-stopped",
          command: ["--config=/etc/oauth2-proxy/oauth2-proxy.cfg"],
          volumes: [
            `${ROUTE_AUTH_DIR}/${profile.containerName}.cfg:/etc/oauth2-proxy/oauth2-proxy.cfg:ro`,
            ...(localIdp ? [`${SYSTEM_CA_BUNDLE_PATH}:${CONTAINER_CA_BUNDLE_PATH}:ro`] : [])
          ],
          ...(localIdp ? { environment: { SSL_CERT_FILE: CONTAINER_CA_BUNDLE_PATH } } : {})
        }
      ];
    })
  );

  return { composeYaml: yamlStringify({ services }), profileConfigs };
}

function buildRouteAuthCompose(
  config: Record<string, unknown>,
  profiles: RouteAuthProfile[],
  clientId: string,
  clientSecret: string,
  cookieSecret: string
): RouteAuthComposeRender {
  const { composeYaml, profileConfigs } = buildRouteAuthComposeArtifacts(config, profiles, clientId, clientSecret, cookieSecret);
  let changed = false;
  for (const [containerName, content] of Object.entries(profileConfigs)) {
    const configPath = `${ROUTE_AUTH_DIR}/${containerName}.cfg`;
    changed = writeIfChanged(configPath, content, { mode: 0o640, directoryMode: 0o700 }) || changed;
    chownSync(configPath, 0, OAUTH2_PROXY_GID);
  }
  return { composeYaml, changed };
}

async function probeRouteAuthListener(profile: RouteAuthProfile): Promise<string | null> {
  const endpoint = `http://127.0.0.1:${profile.port}/ping`;
  let lastResult: Pick<CommandResult, "stdout" | "stderr"> = {
    stdout: "",
    stderr: "probe was not attempted"
  };

  for (let attempt = 0; attempt < ROUTE_AUTH_READY_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure([
      "curl",
      "-fsS",
      "--noproxy",
      "*",
      "--connect-timeout",
      "2",
      "--max-time",
      "3",
      endpoint
    ]);
    if (result.exitCode === 0) {
      return null;
    }

    lastResult = result;
    if (attempt < ROUTE_AUTH_READY_ATTEMPTS - 1) {
      await Bun.sleep(ROUTE_AUTH_READY_INTERVAL_MS);
    }
  }

  return formatRouteAuthReadinessError(profile, endpoint, lastResult);
}

async function probeRouteAuthListeners(profiles: RouteAuthProfile[]): Promise<string[]> {
  const results = await Promise.all(profiles.map((profile) => probeRouteAuthListener(profile)));
  return results.filter((error): error is string => error !== null);
}

async function syncRouteAuthStack(config: Record<string, unknown>, profiles: RouteAuthProfile[]): Promise<string[]> {
  const errors: string[] = [];
  mkdirSync(ROUTE_AUTH_DIR, { recursive: true, mode: 0o700 });

  if (profiles.length === 0) {
    writeIfChanged(ROUTE_AUTH_COMPOSE_PATH, yamlStringify({ services: {} }), { mode: 0o600, directoryMode: 0o700 });
    await runAllowFailure(["docker", "compose", "-f", ROUTE_AUTH_COMPOSE_PATH, "down", "--remove-orphans"]);
    return errors;
  }

  if (!existsSync(OAUTH2_PROXY_COOKIE_SECRET_PATH)) {
    errors.push(`route auth cookie secret is missing: ${OAUTH2_PROXY_COOKIE_SECRET_PATH}`);
    return errors;
  }
  const cookieSecret = readFileSync(OAUTH2_PROXY_COOKIE_SECRET_PATH, "utf8").trim();
  const idpMode = configString(config, "terrarium_idp_mode");
  const outputs = idpMode === "local" ? readJsonFile<Record<string, { value?: string }>>("/etc/terrarium/zitadel-apps.json", {}) : {};
  const clientId =
    (idpMode === "local" ? outputs.routes_client_id?.value : undefined) || configString(config, "terrarium_oidc_client_id");
  const clientSecret =
    (idpMode === "local" ? outputs.routes_client_secret?.value : undefined) || configString(config, "terrarium_oidc_client_secret");

  if (!configString(config, "terrarium_oidc_issuer")) {
    errors.push("route auth requires terrarium_oidc_issuer");
    return errors;
  }
  if (!clientId || !clientSecret) {
    errors.push("route auth requires an OIDC client for published route callbacks");
    return errors;
  }
  if (![16, 24, 32].includes(cookieSecret.length)) {
    errors.push("route auth cookie secret is invalid");
    return errors;
  }

  const rendered = buildRouteAuthCompose(config, profiles, clientId, clientSecret, cookieSecret);
  const changed = writeIfChanged(ROUTE_AUTH_COMPOSE_PATH, rendered.composeYaml, { mode: 0o600, directoryMode: 0o700 }) || rendered.changed;
  const upArgs = ["docker", "compose", "-f", ROUTE_AUTH_COMPOSE_PATH, "up", "-d", "--remove-orphans"];
  if (changed) {
    upArgs.push("--force-recreate");
  }
  const result = await runAllowFailure(upArgs);
  if (result.exitCode !== 0) {
    errors.push(formatRouteAuthCommandFailure("failed to reconcile route auth stack", result));
    return errors;
  }

  errors.push(...(await probeRouteAuthListeners(profiles)));
  return errors;
}

function buildStaticConfig(config: Record<string, unknown>, extraEntrypoints: Record<string, { address: string }>): string {
  return yamlStringify({
    api: {},
    entryPoints: {
      web: { address: ":80" },
      websecure: { address: ":443" },
      bootstrapweb: { address: "127.0.0.1:18080" },
      ...extraEntrypoints
    },
    providers: {
      file: {
        directory: "/etc/traefik/dynamic",
        watch: true
      }
    },
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          email: configString(config, "terrarium_acme_email") || configString(config, "terrarium_email"),
          storage: "/var/lib/traefik/acme.json",
          httpChallenge: {
            entryPoint: "web"
          }
        }
      }
    },
    log: { level: "INFO" }
  });
}

export function buildDynamicConfig(containers: LxcInstance[], config: Record<string, unknown>, backendTargets: Record<string, ProxyBackendTarget> = {}): {
  dynamicYaml: string;
  extraEntrypoints: Record<string, { address: string }>;
  ufwPorts: DesiredPort[];
  authProfiles: RouteAuthProfile[];
  errors: string[];
} {
  const dynamic: Record<string, unknown> = {
    http: {
      middlewares: {
        "terrarium-redirect-to-https": {
          redirectScheme: {
            scheme: "https"
          }
        }
      },
      routers: {},
      services: {}
    },
    tcp: {
      routers: {},
      services: {}
    },
    udp: {
      routers: {},
      services: {}
    }
  };

  const httpRouters = (dynamic.http as Record<string, unknown>).routers as Record<string, unknown>;
  const httpServices = (dynamic.http as Record<string, unknown>).services as Record<string, unknown>;
  const httpMiddlewares = (dynamic.http as Record<string, unknown>).middlewares as Record<string, unknown>;
  const tcpRouters = (dynamic.tcp as Record<string, unknown>).routers as Record<string, unknown>;
  const tcpServices = (dynamic.tcp as Record<string, unknown>).services as Record<string, unknown>;
  const udpRouters = (dynamic.udp as Record<string, unknown>).routers as Record<string, unknown>;
  const udpServices = (dynamic.udp as Record<string, unknown>).services as Record<string, unknown>;
  const extraEntrypoints: Record<string, { address: string }> = {};
  const ufwPorts: DesiredPort[] = [];
  const httpClaims = new Set<string>();
  const oauthProfileSchemes = new Map<string, "http" | "https">();
  const portClaims = new Set<string>();
  const errors: string[] = [];
  const { profiles: authProfiles, errors: authProfileErrors } = buildRouteAuthProfiles(containers, config);
  errors.push(...authProfileErrors);
  const authProfileByKey = new Map(authProfiles.map((profile) => [profile.key, profile]));

  if (authProfiles.length > 0) {
    for (const profile of authProfiles) {
      httpServices[profile.serviceName] = {
        loadBalancer: {
          servers: [{ url: `http://127.0.0.1:${profile.port}` }]
        }
      };
    }
  }

  const ensureRouteAuthRouters = (profile: RouteAuthProfile, scheme: "http" | "https"): void => {
    const existingScheme = oauthProfileSchemes.get(profile.key);
    if (existingScheme === "https" || existingScheme === scheme) {
      return;
    }

    oauthProfileSchemes.set(profile.key, scheme);
    const rule = `Host(\`${profile.host}\`) && PathPrefix(\`${profile.proxyPrefix}/\`)`;
    const httpRouterName = `${profile.serviceName}-oauth2-http`;
    if (scheme === "https") {
      httpRouters[httpRouterName] = {
        entryPoints: ["web"],
        rule,
        service: profile.serviceName,
        middlewares: ["terrarium-redirect-to-https"],
        priority: 550
      };
      httpRouters[`${profile.serviceName}-oauth2-https`] = {
        entryPoints: ["websecure"],
        rule,
        service: profile.serviceName,
        tls: { certResolver: "letsencrypt" },
        priority: 550
      };
      return;
    }

    httpRouters[httpRouterName] = {
      entryPoints: ["web"],
      rule,
      service: profile.serviceName,
      priority: 550
    };
  };

  const ensureRouteAuthMiddleware = (profile: RouteAuthProfile): void => {
    if (httpMiddlewares[profile.middlewareName]) {
      return;
    }
    httpMiddlewares[profile.middlewareName] = {
      forwardAuth: {
        address: `http://127.0.0.1:${profile.port}/`,
        trustForwardHeader: true,
        authResponseHeaders: ["X-Auth-Request-User", "X-Auth-Request-Email", "X-Auth-Request-Groups"]
      }
    };
  };

  for (const container of containers) {
    const name = container.name ?? "unknown";
    const label = container.config?.["user.proxy"]?.trim() ?? "";
    if (!label) {
      continue;
    }

    const ipAddress = findIpv4(container);

    for (const [index, rawItem] of splitProxyItems(label).entries()) {
      let item: ReturnType<typeof parseProxyItem>;
      try {
        item = parseProxyItem(rawItem);
      } catch (error) {
        errors.push(`${name}: ${String(error).replace(/^Error: /, "")}`);
        continue;
      }

      if (item.kind === "http") {
        const backend = backendTargets[proxyBackendKey(name, "tcp", item.targetPort)];
        const backendAddress = backend?.address ?? ipAddress;
        const backendPort = backend?.port ?? item.targetPort;
        if (!backendAddress) {
          errors.push(`${name}: skipped HTTP route ${rawItem} because no backend address is available`);
          continue;
        }

        const authProfile = item.auth.enabled ? authProfileByKey.get(routeAuthProfileKey(item.host, item.auth.groups)) : undefined;
        if (item.auth.enabled && !authProfile) {
          continue;
        }

        const claim = `${item.scheme}:${item.host}:${item.path}`;
        if (httpClaims.has(claim)) {
          errors.push(`${name}: duplicate HTTP route ${rawItem}`);
          continue;
        }
        httpClaims.add(claim);

        const suffix = slugify(`${name}-${item.host}-${item.targetPort}-${index}`);
        const serviceName = `lxc-${suffix}`;
        httpServices[serviceName] = {
          loadBalancer: {
            servers: [{ url: `http://${backendAddress}:${backendPort}` }]
          }
        };

        let rule = `Host(\`${item.host}\`)`;
        if (item.path !== "/") {
          rule += ` && PathPrefix(\`${item.path}\`)`;
        }

        if (item.scheme === "https") {
          httpRouters[`${serviceName}-http`] = {
            entryPoints: ["web"],
            rule,
            service: serviceName,
            middlewares: ["terrarium-redirect-to-https"]
          };
          httpRouters[`${serviceName}-https`] = {
            entryPoints: ["websecure"],
            rule,
            service: serviceName,
            tls: { certResolver: "letsencrypt" },
            ...(item.auth.enabled
              ? {
                  middlewares: [authProfile!.middlewareName]
                }
              : {})
          };
        } else {
          httpRouters[`${serviceName}-http`] = {
            entryPoints: ["web"],
            rule,
            service: serviceName,
            ...(item.auth.enabled
              ? {
                  middlewares: [authProfile!.middlewareName]
                }
              : {})
          };
        }

        if (authProfile) {
          ensureRouteAuthRouters(authProfile, item.scheme);
          ensureRouteAuthMiddleware(authProfile);
        }
        continue;
      }

      const claim = `${item.kind}:${item.hostPort}`;
      if (portClaims.has(claim)) {
        errors.push(`${name}: duplicate ${item.kind.toUpperCase()} host port ${item.hostPort}`);
        continue;
      }
      portClaims.add(claim);

      const backend = backendTargets[proxyBackendKey(name, item.kind, item.containerPort)];
      const backendAddress = backend?.address ?? ipAddress;
      const backendPort = backend?.port ?? item.containerPort;
      if (!backendAddress) {
        errors.push(`${name}: skipped ${item.kind.toUpperCase()} route ${rawItem} because no backend address is available`);
        continue;
      }

      const entrypointName = `${item.kind}-${item.hostPort}`;
      extraEntrypoints[entrypointName] = {
        address: `:${item.hostPort}/${item.kind}`
      };
      ufwPorts.push({ proto: item.kind, port: item.hostPort });

      const serviceSuffix = slugify(`${name}-${item.kind}-${item.hostPort}`);
      const serviceName = `lxc-${serviceSuffix}`;
      if (item.kind === "tcp") {
        tcpServices[serviceName] = {
          loadBalancer: {
            servers: [{ address: `${backendAddress}:${backendPort}` }]
          }
        };
        tcpRouters[`${serviceName}-router`] = {
          entryPoints: [entrypointName],
          rule: "HostSNI(`*`)",
          service: serviceName
        };
      } else {
        udpServices[serviceName] = {
          loadBalancer: {
            servers: [{ address: `${backendAddress}:${backendPort}` }]
          }
        };
        udpRouters[`${serviceName}-router`] = {
          entryPoints: [entrypointName],
          service: serviceName
        };
      }
    }
  }

  if (Object.keys(httpRouters).length === 0) {
    delete (dynamic.http as Record<string, unknown>).middlewares;
  }
  if (Object.keys(httpRouters).length === 0 && Object.keys(httpServices).length === 0) {
    delete dynamic.http;
  }
  if (Object.keys(tcpRouters).length === 0 && Object.keys(tcpServices).length === 0) {
    delete dynamic.tcp;
  }
  if (Object.keys(udpRouters).length === 0 && Object.keys(udpServices).length === 0) {
    delete dynamic.udp;
  }

  return {
    dynamicYaml: yamlStringify(dynamic),
    extraEntrypoints,
    ufwPorts,
    authProfiles,
    errors
  };
}

export async function proxySyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  await withProxySyncLock(async () => {
    const config = loadConfig(configPath, PREFIX);
    const containers = await enrichInstanceState(await loadInstancesForProxySync());
    const { targets: backendTargets, errors: backendErrors } = await syncLxdProxyBackends(containers);
    const { dynamicYaml, extraEntrypoints, ufwPorts, authProfiles, errors } = buildDynamicConfig(containers, config, backendTargets);
    const staticYaml = buildStaticConfig(config, extraEntrypoints);

    assertProxySyncSucceeded({
      dynamicErrors: errors,
      backendErrors
    });

    const staticChanged = writeIfChanged(STATIC_CONFIG_PATH, staticYaml);
    writeIfChanged(DYNAMIC_CONFIG_PATH, dynamicYaml);

    const localRouteClientErrors = authProfiles.length > 0 ? await syncLocalRoutesClient(config, authProfiles) : [];
    const routeAuthErrors = await syncRouteAuthStack(config, authProfiles);
    const ufwErrors = await syncUfw(ufwPorts);

    if (staticChanged) {
      await runText(["systemctl", "restart", "traefik"], PREFIX);
    }

    assertProxySyncSucceeded({
      dynamicErrors: [],
      ufwErrors,
      backendErrors: [],
      localRouteClientErrors,
      routeAuthErrors
    });
  });
}
