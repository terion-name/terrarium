import { chmodSync, existsSync as nodeExistsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged } from "./lib/common";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const DEFAULT_LOGTO_INSTANCE_NAME = "terrarium-idp";
const DEFAULT_LOGTO_DIR = "/var/lib/terrarium/logto";
const DEFAULT_LOGTO_COMPOSE_PROJECT = "terrarium-logto";
const DEFAULT_LOGTO_COMPOSE_FILE = "/var/lib/terrarium/logto/docker-compose.yml";
const DEFAULT_LOGTO_MANAGEMENT_API_RESOURCE = "https://default.logto.app/api";
const LOGTO_ADMIN_MANAGEMENT_API_RESOURCE = "https://admin.logto.app/api";
const LOGTO_PROJECT_ID = "default";
const WAIT_INTERVAL_MS = 5000;
const WAIT_ATTEMPTS = 36;
const LOGTO_HTTP_STATUS_MARKER = "__terrarium_logto_http_status__:";
const DEFAULT_SYSTEM_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const TERRARIUM_SECRET_NAME = "terrarium";
const LOGTO_ADMIN_PASSWORD_ENV = "TERRARIUM_LOGTO_ADMIN_PASSWORD";
const LOGTO_ADMIN_USERNAME = "terrarium_admin";
const LOGTO_MANAGEMENT_APP_CANDIDATES_SQL = `
create function pg_temp.terrarium_logto_management_app_candidates()
returns table(app_id text, secret text)
language plpgsql
as $terrarium$
begin
  create temporary table if not exists terrarium_logto_management_app_candidate_rows (
    app_id text not null,
    secret text not null,
    app_priority integer not null,
    source_priority integer not null
  ) on commit drop;
  truncate table terrarium_logto_management_app_candidate_rows;

  begin
    if to_regclass('public.application_secrets') is not null then
      execute $sql$
        insert into terrarium_logto_management_app_candidate_rows (app_id, secret, app_priority, source_priority)
        select
          app.id::text as app_id,
          latest_secret.value::text as secret,
          case when app.id = 'm-default' then 0 when app.id = 'm-admin' then 1 else 2 end as app_priority,
          0 as source_priority
        from applications app
        join lateral (
          select app_secret.value
          from application_secrets app_secret
          where app_secret.application_id = app.id
            and coalesce(app_secret.value::text, '') <> ''
            and (app_secret.expires_at is null or app_secret.expires_at > now())
          order by app_secret.created_at desc nulls last
          limit 1
        ) latest_secret on true
      $sql$;
    end if;
  exception
    when undefined_table or undefined_column then
      -- Older Logto versions do not have application_secrets or all of its current columns.
  end;

  begin
    execute $sql$
      insert into terrarium_logto_management_app_candidate_rows (app_id, secret, app_priority, source_priority)
      select
        id::text as app_id,
        secret::text as secret,
        case when id = 'm-default' then 0 when id = 'm-admin' then 1 else 2 end as app_priority,
        1 as source_priority
      from applications
      where coalesce(secret::text, '') <> ''
    $sql$;
  exception
    when undefined_table or undefined_column then
      -- Newer Logto schemas may rely only on application_secrets.
  end;

  return query execute $sql$
    select deduped.app_id, deduped.secret
    from (
      select distinct on (candidate_rows.app_id, candidate_rows.secret)
        candidate_rows.app_id,
        candidate_rows.secret,
        candidate_rows.app_priority,
        candidate_rows.source_priority
      from terrarium_logto_management_app_candidate_rows candidate_rows
      order by candidate_rows.app_id, candidate_rows.secret, candidate_rows.source_priority
    ) deduped
    order by deduped.app_priority, deduped.app_id, deduped.source_priority, deduped.secret
  $sql$;
end
$terrarium$;

select app_id, secret from pg_temp.terrarium_logto_management_app_candidates();
`.trim();

type EffectiveIdpProvider = "zitadel" | "logto" | "generic";

function nonEmptyConfigValue(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function resolveEffectiveIdpProvider(mode: string, explicitProvider = ""): EffectiveIdpProvider {
  const provider = explicitProvider.trim().toLowerCase();
  if (provider === "zitadel" || provider === "logto") {
    return provider;
  }
  if (provider) {
    throw new Error(`invalid IDP provider ${JSON.stringify(explicitProvider)}; expected one of: zitadel, logto`);
  }
  return mode.trim().toLowerCase() === "local" ? "zitadel" : "generic";
}

function resolveLocalIdpOutputsPath(config: Record<string, unknown>): string {
  return (
    nonEmptyConfigValue(config, "terrarium_local_idp_outputs_path") ||
    nonEmptyConfigValue(config, "terrarium_zitadel_outputs_path") ||
    "/etc/terrarium/zitadel-apps.json"
  );
}

function defaultIdpProviderValues(provider: EffectiveIdpProvider): { groupsClaim: string; scopes: string } {
  if (provider === "logto") {
    return { groupsClaim: "roles", scopes: "openid profile email roles" };
  }
  return { groupsClaim: "groups", scopes: "openid profile email" };
}

function resolveLxdOidcGroupsClaim(config: Record<string, unknown>, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_lxd_oidc_groups_claim") || defaultIdpProviderValues(provider).groupsClaim;
}

function resolveLxdOidcScopes(config: Record<string, unknown>, provider: EffectiveIdpProvider): string {
  return nonEmptyConfigValue(config, "terrarium_lxd_oidc_scopes") || defaultIdpProviderValues(provider).scopes;
}

type CommandOptions = { cwd?: string; stdin?: string | Uint8Array };
type CommandResult = { exitCode: number; stdout: string; stderr: string };
type OutputValue = { value?: string };
type OutputMap = Record<string, OutputValue>;
type WriteIfChanged = (path: string, content: string, options?: { mode?: number; directoryMode?: number }) => boolean;

export type LogtoHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type LogtoApiCall = <T>(method: LogtoHttpMethod, path: string, body?: unknown, query?: Record<string, string>) => Promise<T>;

export type LogtoSyncDependencies = {
  loadConfig: (configPath: string, prefix: string) => Record<string, unknown>;
  runAllowFailure: (cmd: string[], options?: CommandOptions) => Promise<CommandResult>;
  runText: (cmd: string[], prefix: string, options?: CommandOptions) => Promise<string>;
  readJsonFile: <T>(path: string, fallback: T) => T;
  writeIfChanged: WriteIfChanged;
  which: (name: string) => string | null;
  existsSync: (path: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  writeHeaderFile: (content: string, label: string) => HeaderFile;
};

export type HeaderFile = { dir: string; path: string };

export type LogtoRuntime = {
  instanceName: string;
  logtoDir: string;
  composeProject: string;
  composeFile: string;
};

export type LogtoPostgresCommand = {
  cmd: string[];
  cwd?: string;
};

export type LogtoManagementAppCandidate = {
  appId: string;
  secret: string;
};

export type LogtoTokenAuthMethod = "basic" | "post";

export type LogtoTokenRequest = {
  url: string;
  headers: string;
  stdin: string;
  authMethod: LogtoTokenAuthMethod;
};

export type LogtoManagementSession = {
  token: string;
  apiEndpoint: string;
  tokenEndpoint: string;
};

export type LogtoManagementEndpoint = {
  tokenEndpoint: string;
  apiEndpoint: string;
};

export type LocalLogtoAppKey = "cockpit" | "lxd" | "routes";

export type LocalLogtoOidcAppSpec = {
  outputPrefix: LocalLogtoAppKey;
  name: string;
  description: string;
  type: "Traditional";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  customData: TerrariumLogtoCustomData;
  requireSecret: boolean;
};

export type TerrariumLogtoCustomData = {
  terrarium: {
    managed: true;
    provider: "logto";
    app: LocalLogtoAppKey;
  };
};

export type LocalLogtoOidcApp = {
  appId: string;
  clientId: string;
  clientSecret?: string;
};

export type LogtoSignInMethod = Record<string, unknown> & {
  identifier?: string;
  password?: boolean;
  verificationCode?: boolean;
  isPasswordPrimary?: boolean;
};

export type LogtoSignUpExperience = Record<string, unknown> & {
  identifiers?: string[];
  password?: boolean;
  verify?: boolean;
};

export type LogtoSignInExperience = Record<string, unknown> & {
  signIn?: {
    methods?: LogtoSignInMethod[];
  };
  signUp?: LogtoSignUpExperience;
};

export type LogtoApplication = Record<string, unknown> & {
  id?: string;
  name?: string;
  type?: string;
  customData?: unknown;
  oidcClientMetadata?: unknown;
};

export type LogtoRole = Record<string, unknown> & {
  id?: string;
  name?: string;
  type?: string;
};

export type LogtoUser = Record<string, unknown> & {
  id?: string;
  primaryEmail?: string;
  email?: string;
  username?: string;
};

const defaultDependencies: LogtoSyncDependencies = {
  loadConfig,
  runAllowFailure,
  runText,
  readJsonFile,
  writeIfChanged,
  which: (name: string) => Bun.which(name),
  existsSync: nodeExistsSync,
  sleep: (ms: number) => Bun.sleep(ms),
  writeHeaderFile: writeLogtoHeaderFile
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  for (const key of ["data", "items", "result", "roles", "users", "applications", "secrets"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trustedCaArgs(existsSync: (path: string) => boolean = nodeExistsSync): string[] {
  return existsSync(DEFAULT_SYSTEM_CA_BUNDLE_PATH) ? ["--cacert", DEFAULT_SYSTEM_CA_BUNDLE_PATH] : [];
}

export function isRetriableLogtoApiError(message: string): boolean {
  const lowered = message.toLowerCase();
  return [
    "failed to connect",
    "connection refused",
    "empty reply from server",
    "timed out",
    "timeout was reached",
    "connection reset",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "http 502",
    "http 503",
    "http 504"
  ].some((needle) => lowered.includes(needle));
}

export function parseLogtoHttpOutput(raw: string): { status: number; body: string } {
  const markerIndex = raw.lastIndexOf(LOGTO_HTTP_STATUS_MARKER);
  if (markerIndex === -1) {
    throw new Error("Logto API response did not include an HTTP status marker");
  }

  const body = raw.slice(0, markerIndex).replace(/\n$/, "");
  const statusRaw = raw.slice(markerIndex + LOGTO_HTTP_STATUS_MARKER.length).trim();
  const status = Number(statusRaw);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`Logto API response included invalid HTTP status: ${statusRaw || "<empty>"}`);
  }
  return { status, body };
}

export function redactLogtoSecrets(message: string, secrets: readonly string[]): string {
  let redacted = message;
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function compactLogtoBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").slice(0, 2000) || "<empty>";
}

function formatLogtoHttpFailure(method: string, path: string, status: number, body: string): string {
  return `Logto API ${method} ${path} returned HTTP ${status}: ${compactLogtoBody(body)}`;
}

export function writeLogtoHeaderFile(content: string, label: string): HeaderFile {
  const safeLabel = label.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "api";
  const dir = mkdtempSync(join(tmpdir(), `terrarium-logto-${safeLabel}-`));
  chmodSync(dir, 0o700);
  const path = join(dir, "headers");
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return { dir, path };
}

export function buildLogtoCurlCommand(
  authDomain: string,
  method: LogtoHttpMethod,
  url: string,
  headerPath: string,
  hasBody = false,
  existsSync: (path: string) => boolean = nodeExistsSync
): string[] {
  const cmd = [
    "curl",
    "-sS",
    "--noproxy",
    "*",
    ...trustedCaArgs(existsSync),
    "--resolve",
    `${authDomain}:443:127.0.0.1`,
    "--connect-timeout",
    "10",
    "--max-time",
    "20",
    "--write-out",
    `\n${LOGTO_HTTP_STATUS_MARKER}%{http_code}`,
    "-X",
    method,
    "-H",
    `@${headerPath}`,
    url
  ];
  if (hasBody) {
    cmd.push("--data-binary", "@-");
  }
  return cmd;
}

export function buildLogtoTokenRequest(
  endpoint: string,
  managementSecret: string,
  resource = DEFAULT_LOGTO_MANAGEMENT_API_RESOURCE,
  clientId = "m-admin",
  authMethod: LogtoTokenAuthMethod = "basic"
): LogtoTokenRequest {
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("resource", resource);
  body.set("scope", "all");

  const headers = ["Content-Type: application/x-www-form-urlencoded"];
  if (authMethod === "basic") {
    const basicToken = Buffer.from(`${clientId}:${managementSecret}`, "utf8").toString("base64");
    headers.unshift(`Authorization: Basic ${basicToken}`);
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", managementSecret);
  }

  return {
    url: `${endpoint.replace(/\/$/, "")}/oidc/token`,
    headers: `${headers.join("\n")}\n`,
    stdin: body.toString(),
    authMethod
  };
}

export function buildLogtoRuntime(config: Record<string, unknown>): LogtoRuntime {
  return {
    instanceName: configString(config, "terrarium_logto_instance_name", DEFAULT_LOGTO_INSTANCE_NAME),
    logtoDir: configString(config, "terrarium_logto_dir", DEFAULT_LOGTO_DIR),
    composeProject: configString(config, "terrarium_logto_compose_project", DEFAULT_LOGTO_COMPOSE_PROJECT),
    composeFile: configString(config, "terrarium_logto_compose_file", DEFAULT_LOGTO_COMPOSE_FILE)
  };
}

export function buildLogtoPostgresCandidateCommand(runtime: LogtoRuntime, useLxdInstance: boolean): LogtoPostgresCommand {
  const dockerCommand = [
    "docker",
    "compose",
    "--project-name",
    runtime.composeProject,
    "-f",
    runtime.composeFile,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "logto",
    "-d",
    "logto",
    "-t",
    "-A",
    "-q",
    "-c",
    LOGTO_MANAGEMENT_APP_CANDIDATES_SQL
  ];

  if (useLxdInstance) {
    return { cmd: ["lxc", "exec", runtime.instanceName, "--", ...dockerCommand] };
  }
  return { cmd: dockerCommand, cwd: runtime.logtoDir };
}

export function buildLogtoPostgresSecretCommand(runtime: LogtoRuntime, useLxdInstance: boolean): LogtoPostgresCommand {
  return buildLogtoPostgresCandidateCommand(runtime, useLxdInstance);
}

export function parsePsqlManagementAppCandidatesOutput(stdout: string): LogtoManagementAppCandidate[] {
  const candidates: LogtoManagementAppCandidate[] = [];
  const seen = new Set<string>();

  for (const line of stdout
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean)) {
    const delimiter = line.includes("\t") ? "\t" : "|";
    const delimiterIndex = line.indexOf(delimiter);
    if (delimiterIndex <= 0) {
      throw new Error("Logto Management API candidate query returned a row without both app id and secret");
    }

    const appId = line.slice(0, delimiterIndex).trim();
    const secret = line.slice(delimiterIndex + 1).trim();
    if (!appId || !secret) {
      throw new Error("Logto Management API candidate query returned an empty app id or secret");
    }

    const dedupeKey = `${appId}\u0000${secret}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      candidates.push({ appId, secret });
    }
  }

  return candidates;
}

export function parsePsqlSingleSecretOutput(stdout: string): string {
  const candidates = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("failed to read Logto m-admin secret from Postgres output");
  }
  if (candidates.length > 1) {
    throw new Error("Logto m-admin secret query returned multiple rows");
  }
  return candidates[0] ?? "";
}

async function lxcInstanceExists(instanceName: string, dependencies: LogtoSyncDependencies): Promise<boolean> {
  if (!dependencies.which("lxc")) {
    return false;
  }
  return (await dependencies.runAllowFailure(["lxc", "info", instanceName])).exitCode === 0;
}

async function readLogtoManagementAppCandidates(
  runtime: LogtoRuntime,
  dependencies: LogtoSyncDependencies
): Promise<LogtoManagementAppCandidate[]> {
  const useLxdInstance = await lxcInstanceExists(runtime.instanceName, dependencies);
  const command = buildLogtoPostgresCandidateCommand(runtime, useLxdInstance);
  const stdout = await dependencies.runText(command.cmd, PREFIX, { cwd: command.cwd });
  return parsePsqlManagementAppCandidatesOutput(stdout);
}

export function resolveLocalLogtoIssuer(authDomainOrIssuer: string): string {
  const trimmed = authDomainOrIssuer.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  const issuer = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return issuer.endsWith("/oidc") ? issuer : `${issuer}/oidc`;
}

async function waitForTrustedHttpsDiscovery(authDomain: string, expectedIssuer: string, dependencies: LogtoSyncDependencies): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await dependencies.runAllowFailure([
      "curl",
      "-fsS",
      "--noproxy",
      "*",
      ...trustedCaArgs(dependencies.existsSync),
      "--resolve",
      `${authDomain}:443:127.0.0.1`,
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      `https://${authDomain}/oidc/.well-known/openid-configuration`
    ]);
    if (result.exitCode === 0) {
      try {
        const discovery = JSON.parse(result.stdout) as Record<string, unknown>;
        const issuer = String(discovery.issuer || "").trim().replace(/\/+$/, "");
        if (issuer === expectedIssuer) {
          return;
        }
        lastError = issuer
          ? `OIDC discovery issuer ${issuer} did not match expected local Logto issuer ${expectedIssuer}`
          : "OIDC discovery is missing issuer";
      } catch (error) {
        lastError = `failed to parse OIDC discovery: ${String(error).replace(/^Error: /, "")}`;
      }
    } else {
      lastError = result.stderr.trim() || result.stdout.trim() || "OIDC discovery is not reachable yet";
    }
    await dependencies.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for HTTPS Logto OIDC discovery on ${authDomain}: ${lastError}`);
}

function isInvalidClientTokenFailure(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) {
    return false;
  }

  try {
    const parsed = JSON.parse(body || "null") as Record<string, unknown> | null;
    if (stringValue(parsed?.error).toLowerCase() === "invalid_client") {
      return true;
    }
  } catch {
    // Fall through to the compact body check below. Some Logto errors may be plain text.
  }

  const lowered = compactLogtoBody(body).toLowerCase();
  return lowered.includes("invalid_client") || lowered.includes("invalid client");
}

function tokenRedactions(candidate: LogtoManagementAppCandidate, request: LogtoTokenRequest): string[] {
  const basicToken = Buffer.from(`${candidate.appId}:${candidate.secret}`, "utf8").toString("base64");
  return [candidate.secret, basicToken, request.stdin];
}

function localLogtoAdminEndpoint(config: Record<string, unknown>): string {
  const configuredEndpoint = configString(config, "terrarium_logto_admin_endpoint");
  if (configuredEndpoint) {
    return configuredEndpoint;
  }

  const adminPort = configString(config, "terrarium_logto_admin_port", "3002");
  return `http://localhost:${adminPort}`;
}

export function localLogtoManagementEndpoints(authDomain: string, config: Record<string, unknown>): LogtoManagementEndpoint[] {
  const apiEndpoint = `https://${authDomain}`;
  const endpoints: LogtoManagementEndpoint[] = [];
  const seen = new Set<string>();

  for (const tokenEndpoint of [localLogtoAdminEndpoint(config), apiEndpoint]) {
    const trimmed = tokenEndpoint.trim().replace(/\/+$/, "");
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      endpoints.push({ tokenEndpoint: trimmed, apiEndpoint });
    }
  }

  return endpoints;
}

function candidatePriorityForResource(candidate: LogtoManagementAppCandidate, resource: string): number {
  if (resource === DEFAULT_LOGTO_MANAGEMENT_API_RESOURCE) {
    if (candidate.appId === "m-default") {
      return 0;
    }
    if (candidate.appId === "m-admin") {
      return 1;
    }
  }

  if (resource === LOGTO_ADMIN_MANAGEMENT_API_RESOURCE) {
    if (candidate.appId === "m-admin") {
      return 0;
    }
    if (candidate.appId === "m-default") {
      return 1;
    }
  }

  return 2;
}

function orderLogtoManagementCandidates(
  candidates: readonly LogtoManagementAppCandidate[],
  resource: string
): LogtoManagementAppCandidate[] {
  return [...candidates].sort((left, right) => {
    const priority = candidatePriorityForResource(left, resource) - candidatePriorityForResource(right, resource);
    return priority === 0 ? 0 : priority;
  });
}

export function localLogtoManagementApiResources(configuredResource: string): string[] {
  const resources: string[] = [];
  const seen = new Set<string>();
  for (const resource of [configuredResource, LOGTO_ADMIN_MANAGEMENT_API_RESOURCE]) {
    const trimmed = resource.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      resources.push(trimmed);
    }
  }
  return resources;
}

function formatTokenAttemptLabel(
  candidate: LogtoManagementAppCandidate,
  authMethod: LogtoTokenAuthMethod,
  resource: string
): string {
  return `${candidate.appId} [${authMethod}, resource=${resource}]`;
}

function formatTokenCandidateFailures(
  candidateIds: readonly string[],
  resources: readonly string[],
  failuresByAttempt: ReadonlyMap<string, string>
): string {
  const tried = candidateIds.join(", ") || "<none>";
  const resourcesTried = resources.join(", ") || "<none>";
  const failures = [...failuresByAttempt.entries()].map(([attempt, failure]) => `${attempt}: ${failure}`).join("; ") || "<none>";
  return `failed to obtain Logto management token; candidates tried: ${tried}; resources tried: ${resourcesTried}; failures: ${failures}`;
}

export async function requestLogtoManagementToken(
  authDomain: string,
  endpoint: string,
  candidates: readonly LogtoManagementAppCandidate[],
  resource: string,
  dependencies: LogtoSyncDependencies
): Promise<string> {
  if (candidates.length === 0) {
    throw new Error("no Logto Management API candidate applications with non-empty secrets were found in Postgres");
  }

  const resources = localLogtoManagementApiResources(resource);
  if (resources.length === 0) {
    throw new Error("no Logto Management API resources were configured for token acquisition");
  }

  const attemptedCandidateIds: string[] = [];
  const attemptedCandidateIdSet = new Set<string>();
  const failuresByAttempt = new Map<string, string>();
  const authMethods: readonly LogtoTokenAuthMethod[] = ["basic", "post"];

  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    let sawRetriableFailure = false;

    for (const tokenResource of resources) {
      for (const candidate of orderLogtoManagementCandidates(candidates, tokenResource)) {
        if (!attemptedCandidateIdSet.has(candidate.appId)) {
          attemptedCandidateIdSet.add(candidate.appId);
          attemptedCandidateIds.push(candidate.appId);
        }

        for (const authMethod of authMethods) {
          const request = buildLogtoTokenRequest(endpoint, candidate.secret, tokenResource, candidate.appId, authMethod);
          const attemptLabel = formatTokenAttemptLabel(candidate, authMethod, tokenResource);
          const headers = dependencies.writeHeaderFile(request.headers, "token");
          const cmd = buildLogtoCurlCommand(authDomain, "POST", request.url, headers.path, true, dependencies.existsSync);
          const redactions = tokenRedactions(candidate, request);

          try {
            const result = await dependencies.runAllowFailure(cmd, { stdin: request.stdin });
            let failure = "";
            let invalidClient = false;

            if (result.exitCode === 0) {
              const response = parseLogtoHttpOutput(result.stdout);
              if (response.status >= 200 && response.status < 300) {
                try {
                  const parsed = JSON.parse(response.body || "null") as Record<string, unknown> | null;
                  const token = stringValue(parsed?.access_token);
                  if (!token) {
                    throw new Error("Logto token response did not include access_token");
                  }
                  return token;
                } catch (error) {
                  throw new Error(
                    redactLogtoSecrets(
                      `failed to parse Logto token response for candidate ${candidate.appId} using ${authMethod} auth and resource ${tokenResource}: ${String(error).replace(/^Error: /, "")}`,
                      redactions
                    )
                  );
                }
              }
              failure = formatLogtoHttpFailure("POST", "/oidc/token", response.status, response.body);
              invalidClient = isInvalidClientTokenFailure(response.status, response.body);
            } else {
              failure = result.stderr.trim() || result.stdout.trim() || "Logto token request failed";
            }

            failure = redactLogtoSecrets(failure, redactions);
            failuresByAttempt.set(attemptLabel, failure);

            if (invalidClient) {
              continue;
            }
            if (isRetriableLogtoApiError(failure)) {
              sawRetriableFailure = true;
              continue;
            }
            throw new Error(formatTokenCandidateFailures(attemptedCandidateIds, resources, failuresByAttempt));
          } finally {
            rmSync(headers.dir, { recursive: true, force: true });
          }
        }
      }
    }

    if (!sawRetriableFailure) {
      throw new Error(formatTokenCandidateFailures(attemptedCandidateIds, resources, failuresByAttempt));
    }
    await dependencies.sleep(WAIT_INTERVAL_MS);
  }

  throw new Error(`timed out waiting for Logto management token: ${formatTokenCandidateFailures(attemptedCandidateIds, resources, failuresByAttempt)}`);
}

export async function requestLogtoManagementSession(
  authDomain: string,
  endpoints: readonly LogtoManagementEndpoint[],
  candidates: readonly LogtoManagementAppCandidate[],
  resource: string,
  dependencies: LogtoSyncDependencies
): Promise<LogtoManagementSession> {
  const failures: string[] = [];

  for (const endpoint of endpoints) {
    try {
      const token = await requestLogtoManagementToken(authDomain, endpoint.tokenEndpoint, candidates, resource, dependencies);
      return { token, tokenEndpoint: endpoint.tokenEndpoint, apiEndpoint: endpoint.apiEndpoint };
    } catch (error) {
      failures.push(`${endpoint.tokenEndpoint}: ${String(error).replace(/^Error: /, "")}`);
    }
  }

  throw new Error(`failed to obtain Logto management token from local endpoints: ${failures.join("; ") || "<none>"}`);
}

async function logtoApi<T>(
  authDomain: string,
  endpoint: string,
  token: string,
  dependencies: LogtoSyncDependencies,
  method: LogtoHttpMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<T> {
  const url = new URL(path, endpoint.replace(/\/$/, ""));
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = dependencies.writeHeaderFile(`Authorization: Bearer ${token}\nContent-Type: application/json\n`, "api");
  const stdin = body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined;
  const cmd = buildLogtoCurlCommand(authDomain, method, url.toString(), headers.path, stdin !== undefined, dependencies.existsSync);
  const redactions = [token, stdin ?? ""];
  let lastError = "";

  try {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      const result = await dependencies.runAllowFailure(cmd, { stdin });
      if (result.exitCode === 0) {
        const response = parseLogtoHttpOutput(result.stdout);
        if (response.status >= 200 && response.status < 300) {
          try {
            return JSON.parse(response.body || "null") as T;
          } catch (error) {
            throw new Error(
              redactLogtoSecrets(`Logto API ${method} ${path} returned invalid JSON: ${String(error).replace(/^Error: /, "")}`, redactions)
            );
          }
        }
        lastError = formatLogtoHttpFailure(method, path, response.status, response.body);
      } else {
        lastError = result.stderr.trim() || result.stdout.trim() || `Logto API ${method} ${path} failed`;
      }

      lastError = redactLogtoSecrets(lastError, redactions);
      if (!isRetriableLogtoApiError(lastError)) {
        throw new Error(lastError);
      }
      await dependencies.sleep(WAIT_INTERVAL_MS);
    }
  } finally {
    rmSync(headers.dir, { recursive: true, force: true });
  }

  throw new Error(`timed out waiting for Logto API ${method} ${path}: ${redactLogtoSecrets(lastError, redactions)}`);
}

export function localLogtoOidcAppSpecs(config: Record<string, unknown>): LocalLogtoOidcAppSpec[] {
  const manageDomain = configString(config, "terrarium_manage_domain");
  const proxyDomain = configString(config, "terrarium_proxy_domain");
  const lxdDomain = configString(config, "terrarium_lxd_domain");
  return [
    {
      outputPrefix: "cockpit",
      name: "terrarium-cockpit",
      description: "Terrarium management UI OAuth client",
      type: "Traditional",
      redirectUris: [`https://${manageDomain}/oauth2/callback`, `https://${proxyDomain}/oauth2/callback`],
      postLogoutRedirectUris: [`https://${manageDomain}/`, `https://${proxyDomain}/`],
      customData: terrariumLogtoCustomData("cockpit"),
      requireSecret: true
    },
    {
      outputPrefix: "lxd",
      name: "terrarium-lxd",
      description: "Terrarium LXD OAuth client",
      type: "Traditional",
      redirectUris: [`https://${lxdDomain}/oidc/callback`],
      postLogoutRedirectUris: [`https://${lxdDomain}/`],
      customData: terrariumLogtoCustomData("lxd"),
      requireSecret: false
    },
    {
      outputPrefix: "routes",
      name: "terrarium-routes",
      description: "Terrarium route OAuth client",
      type: "Traditional",
      redirectUris: [`https://${manageDomain}/oauth2/app/callback`],
      postLogoutRedirectUris: [`https://${manageDomain}/`],
      customData: terrariumLogtoCustomData("routes"),
      requireSecret: true
    }
  ];
}

function terrariumLogtoCustomData(app: LocalLogtoAppKey): TerrariumLogtoCustomData {
  return { terrarium: { managed: true, provider: "logto", app } };
}

export function buildLogtoApplicationBody(spec: LocalLogtoOidcAppSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    type: spec.type,
    oidcClientMetadata: {
      redirectUris: spec.redirectUris,
      postLogoutRedirectUris: spec.postLogoutRedirectUris
    },
    customData: spec.customData
  };
}

export function matchesTerrariumLogtoApp(app: LogtoApplication, key: LocalLogtoAppKey): boolean {
  const customData = asRecord(app.customData);
  const marker = asRecord(customData.terrarium);
  return marker.managed === true && marker.provider === "logto" && marker.app === key;
}

export function findTerrariumLogtoApp(apps: LogtoApplication[], spec: LocalLogtoOidcAppSpec): LogtoApplication | null {
  const marked = apps.filter((app) => matchesTerrariumLogtoApp(app, spec.outputPrefix));
  if (marked.length > 1) {
    throw new Error(`found multiple Terrarium-managed Logto applications for ${spec.outputPrefix}`);
  }
  if (marked.length === 1) {
    return marked[0];
  }

  const byName = apps.filter((app) => app.name === spec.name);
  if (byName.length > 1) {
    throw new Error(`found multiple Logto applications named ${spec.name}; refusing to choose implicitly`);
  }
  return byName[0] ?? null;
}

function logtoApplicationClientId(app: LogtoApplication): string {
  const oidcClientMetadata = asRecord(app.oidcClientMetadata);
  return stringValue(oidcClientMetadata.clientId) || stringValue(app.clientId) || stringValue(app.id);
}

function logtoApplicationId(app: LogtoApplication): string {
  return stringValue(app.id) || logtoApplicationClientId(app);
}

function logtoSecretValue(value: unknown): string {
  const secret = asRecord(value);
  return stringValue(secret.value) || stringValue(secret.secret) || stringValue(secret.plaintext) || stringValue(secret.clientSecret);
}

export function previousLogtoClientSecret(previousOutputs: OutputMap, outputPrefix: LocalLogtoAppKey, clientId: string): string {
  const previousClientId = previousOutputs[`${outputPrefix}_client_id`]?.value?.trim() ?? "";
  const previousSecret = previousOutputs[`${outputPrefix}_client_secret`]?.value?.trim() ?? "";
  return previousClientId === clientId ? previousSecret : "";
}

const emailPasswordSignInMethods: readonly LogtoSignInMethod[] = [
  {
    identifier: "email",
    isPasswordPrimary: true,
    password: true,
    verificationCode: false
  }
];


function isEmailPasswordSignInMethod(method: LogtoSignInMethod): boolean {
  return (
    method.identifier === "email" &&
    method.isPasswordPrimary === true &&
    method.password === true &&
    method.verificationCode === false
  );
}

function hasOnlyEmailPasswordSignInMethod(experience: LogtoSignInExperience): boolean {
  const methods = asArray(asRecord(experience.signIn).methods).map((method) => asRecord(method) as LogtoSignInMethod);
  return methods.length === 1 && isEmailPasswordSignInMethod(methods[0]!);
}


export async function ensureEmailPasswordSignInExperience(api: LogtoApiCall): Promise<void> {
  const experience = asRecord(await api<unknown>("GET", "/api/sign-in-exp")) as LogtoSignInExperience;
  if (hasOnlyEmailPasswordSignInMethod(experience)) {
    return;
  }

  await api("PATCH", "/api/sign-in-exp", {
    signIn: {
      methods: emailPasswordSignInMethods
    }
  });
}

async function listLogtoApplications(api: LogtoApiCall): Promise<LogtoApplication[]> {
  return asArray(await api<unknown>("GET", "/api/applications")).map((app) => asRecord(app) as LogtoApplication);
}

async function listLogtoApplicationSecrets(api: LogtoApiCall, appId: string): Promise<unknown[]> {
  return asArray(await api<unknown>("GET", `/api/applications/${encodeURIComponent(appId)}/secrets`));
}

async function findExistingLogtoApplicationSecret(api: LogtoApiCall, appId: string): Promise<string> {
  const secrets = await listLogtoApplicationSecrets(api, appId);
  const named = secrets.find((entry) => asRecord(entry).name === TERRARIUM_SECRET_NAME);
  return logtoSecretValue(named) || logtoSecretValue(secrets.find((entry) => logtoSecretValue(entry)));
}

async function ensureLogtoApplicationSecret(
  api: LogtoApiCall,
  appId: string,
  spec: LocalLogtoOidcAppSpec,
  previousOutputs: OutputMap,
  clientId: string,
  createdSecret: string
): Promise<string> {
  const previousSecret = previousLogtoClientSecret(previousOutputs, spec.outputPrefix, clientId);
  if (previousSecret) {
    return previousSecret;
  }
  if (createdSecret) {
    return createdSecret;
  }

  const existing = await findExistingLogtoApplicationSecret(api, appId);
  if (existing) {
    return existing;
  }

  if (!spec.requireSecret) {
    return "";
  }

  const created = await api<unknown>("POST", `/api/applications/${encodeURIComponent(appId)}/secrets`, { name: TERRARIUM_SECRET_NAME });
  const secret = logtoSecretValue(created);
  if (!secret) {
    throw new Error(`failed to obtain client secret for ${spec.name}`);
  }
  return secret;
}

async function ensureLocalLogtoOidcApp(
  api: LogtoApiCall,
  apps: LogtoApplication[],
  spec: LocalLogtoOidcAppSpec,
  previousOutputs: OutputMap
): Promise<LocalLogtoOidcApp> {
  const existing = findTerrariumLogtoApp(apps, spec);
  const body = buildLogtoApplicationBody(spec);
  const app = existing
    ? ({ ...existing, ...(await api<LogtoApplication>("PATCH", `/api/applications/${encodeURIComponent(logtoApplicationId(existing))}`, body)) } as LogtoApplication)
    : ((await api<LogtoApplication>("POST", "/api/applications", body)) as LogtoApplication);

  const appId = logtoApplicationId(app);
  const clientId = logtoApplicationClientId(app);
  if (!appId || !clientId) {
    throw new Error(`failed to ensure ${spec.name} Logto application`);
  }

  const createdSecret = logtoSecretValue(app);
  const clientSecret = await ensureLogtoApplicationSecret(api, appId, spec, previousOutputs, clientId, createdSecret);
  return clientSecret ? { appId, clientId, clientSecret } : { appId, clientId };
}

async function ensureLocalLogtoApplications(
  config: Record<string, unknown>,
  api: LogtoApiCall,
  outputsPath: string,
  issuer: string,
  dependencies: LogtoSyncDependencies
): Promise<Record<LocalLogtoAppKey, LocalLogtoOidcApp>> {
  const previousOutputs = dependencies.readJsonFile<OutputMap>(outputsPath, {});
  const listedApps = await listLogtoApplications(api);
  const apps = {} as Record<LocalLogtoAppKey, LocalLogtoOidcApp>;
  for (const spec of localLogtoOidcAppSpecs(config)) {
    apps[spec.outputPrefix] = await ensureLocalLogtoOidcApp(api, listedApps, spec, previousOutputs);
  }
  writeLocalLogtoOutputs(outputsPath, LOGTO_PROJECT_ID, apps, issuer, dependencies.writeIfChanged);
  return apps;
}

export function buildLocalIdpOutputs(projectId: string, apps: Record<LocalLogtoAppKey, LocalLogtoOidcApp>, issuer: string): string {
  const localLogtoIssuer = resolveLocalLogtoIssuer(issuer);
  if (!localLogtoIssuer) {
    throw new Error("Logto issuer is empty");
  }
  const output: Record<string, { sensitive: boolean; type: "string"; value: string }> = {
    cockpit_client_id: { sensitive: true, type: "string", value: apps.cockpit.clientId },
    cockpit_client_secret: { sensitive: true, type: "string", value: apps.cockpit.clientSecret ?? "" },
    issuer: { sensitive: false, type: "string", value: localLogtoIssuer },
    lxd_client_id: { sensitive: true, type: "string", value: apps.lxd.clientId },
    project_id: { sensitive: false, type: "string", value: projectId },
    routes_client_id: { sensitive: true, type: "string", value: apps.routes.clientId },
    routes_client_secret: { sensitive: true, type: "string", value: apps.routes.clientSecret ?? "" }
  };
  if (apps.lxd.clientSecret) {
    output.lxd_client_secret = { sensitive: true, type: "string", value: apps.lxd.clientSecret };
  }
  return `${JSON.stringify(output, null, 2)}\n`;
}

export function writeLocalLogtoOutputs(
  outputsPath: string,
  projectId: string,
  apps: Record<LocalLogtoAppKey, LocalLogtoOidcApp>,
  issuer: string,
  writer: WriteIfChanged = writeIfChanged
): boolean {
  return writer(outputsPath, buildLocalIdpOutputs(projectId, apps, issuer), { mode: 0o600 });
}

function logtoRoleType(role: LogtoRole): string {
  return stringValue(role.type).toLowerCase();
}

function roleMatches(role: LogtoRole, name: string): boolean {
  const type = logtoRoleType(role);
  return role.name === name && (!type || type === "user");
}

export async function ensureLogtoAdminRole(api: LogtoApiCall, adminGroup: string): Promise<LogtoRole> {
  const roles = asArray(await api<unknown>("GET", "/api/roles", undefined, { type: "User" })).map((role) => asRecord(role) as LogtoRole);
  const existing = roles.find((role) => roleMatches(role, adminGroup));
  if (existing?.id) {
    return existing;
  }

  try {
    const created = asRecord(
      await api<unknown>("POST", "/api/roles", {
        name: adminGroup,
        description: "Terrarium management administrators",
        type: "User"
      })
    ) as LogtoRole;
    if (created.id) {
      return created;
    }
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes("already") || !message.includes("exist")) {
      throw error;
    }
  }

  const refreshed = asArray(await api<unknown>("GET", "/api/roles", undefined, { type: "User" })).map((role) => asRecord(role) as LogtoRole);
  const role = refreshed.find((entry) => roleMatches(entry, adminGroup));
  if (!role?.id) {
    throw new Error(`failed to ensure Logto admin role ${adminGroup}`);
  }
  return role;
}

function emailsForLogtoUser(user: LogtoUser): string[] {
  const emails = [stringValue(user.primaryEmail), stringValue(user.email)];
  const profile = asRecord(user.profile);
  emails.push(stringValue(profile.email));
  return emails.filter(Boolean);
}

function logtoUsersMatchingEmail(users: LogtoUser[], email: string): LogtoUser[] {
  const normalized = email.trim().toLowerCase();
  return users.filter((user) => emailsForLogtoUser(user).some((candidate) => candidate.toLowerCase() === normalized));
}

export function selectLogtoUserByEmail(users: LogtoUser[], email: string): LogtoUser {
  const matches = logtoUsersMatchingEmail(users, email);
  if (matches.length === 0) {
    throw new Error(`failed to find Logto user for email ${email}`);
  }
  if (matches.length > 1) {
    throw new Error(`found multiple Logto users for email ${email}`);
  }
  return matches[0];
}

async function findLogtoAdminUser(api: LogtoApiCall, email: string): Promise<LogtoUser | null> {
  const users = asArray(await api<unknown>("GET", "/api/users", undefined, { search: email })).map((user) => asRecord(user) as LogtoUser);
  const matches = logtoUsersMatchingEmail(users, email);
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error(`found multiple Logto users for email ${email}`);
  }
  return matches[0];
}

function buildLogtoAdminUserBody(email: string, password: string): Record<string, unknown> {
  return {
    primaryEmail: email,
    username: LOGTO_ADMIN_USERNAME,
    name: "Terrarium Admin",
    password,
    emailVerified: true,
    customData: {
      terrarium: {
        managed: true,
        provider: "logto",
        user: "admin"
      }
    }
  };
}

function normalizeCreatedLogtoUser(user: LogtoUser, email: string): LogtoUser {
  return {
    ...user,
    primaryEmail: stringValue(user.primaryEmail) || stringValue(user.email) || email,
    username: stringValue(user.username) || LOGTO_ADMIN_USERNAME
  };
}

async function ensureLogtoAdminUsername(api: LogtoApiCall, user: LogtoUser): Promise<LogtoUser> {
  if (stringValue(user.username) || !user.id) {
    return user;
  }

  const patched = asRecord(
    await api<unknown>("PATCH", `/api/users/${encodeURIComponent(user.id)}`, { username: LOGTO_ADMIN_USERNAME })
  ) as LogtoUser;
  return {
    ...user,
    ...patched,
    username: stringValue(patched.username) || LOGTO_ADMIN_USERNAME
  };
}

export async function ensureLogtoAdminUser(api: LogtoApiCall, email: string): Promise<LogtoUser> {
  const existing = await findLogtoAdminUser(api, email);
  if (existing) {
    return ensureLogtoAdminUsername(api, existing);
  }

  const password = process.env[LOGTO_ADMIN_PASSWORD_ENV] ?? "";
  if (!password) {
    throw new Error(`${LOGTO_ADMIN_PASSWORD_ENV} is required to create missing Logto admin user ${email}`);
  }

  const created = normalizeCreatedLogtoUser(
    asRecord(await api<unknown>("POST", "/api/users", buildLogtoAdminUserBody(email, password))) as LogtoUser,
    email
  );
  if (created.id) {
    return created;
  }

  const refreshed = await findLogtoAdminUser(api, email);
  if (!refreshed?.id) {
    throw new Error(`failed to create Logto user for email ${email}`);
  }
  return ensureLogtoAdminUsername(api, refreshed);
}

export async function ensureLogtoAdminUserRole(api: LogtoApiCall, email: string, role: LogtoRole): Promise<void> {
  if (!role.id) {
    throw new Error(`Logto admin role ${role.name ?? "<unknown>"} is missing an id`);
  }
  const user = await ensureLogtoAdminUser(api, email);
  if (!user.id) {
    throw new Error(`Logto user for email ${email} is missing an id`);
  }

  const assignedRoles = asArray(await api<unknown>("GET", `/api/users/${encodeURIComponent(user.id)}/roles`)).map((entry) => asRecord(entry) as LogtoRole);
  if (assignedRoles.some((entry) => entry.id === role.id || roleMatches(entry, role.name ?? ""))) {
    return;
  }

  await api("POST", `/api/users/${encodeURIComponent(user.id)}/roles`, { roleIds: [role.id] });
}

async function ensureManagementGroupProvisioning(config: Record<string, unknown>, api: LogtoApiCall): Promise<void> {
  const adminGroup = configString(config, "terrarium_admin_group", "terrarium-admins");
  if (!adminGroup) {
    throw new Error("terrarium_admin_group is empty");
  }
  const role = await ensureLogtoAdminRole(api, adminGroup);
  const adminEmail = configString(config, "terrarium_logto_admin_email") || configString(config, "terrarium_email");
  if (adminEmail) {
    await ensureLogtoAdminUserRole(api, adminEmail, role);
  }
}

export function buildLxdOidcConfigCommands(config: Record<string, unknown>, issuer: string, lxdApp: LocalLogtoOidcApp): string[][] {
  if (!lxdApp.clientId) {
    return [];
  }
  const commands = [
    ["/snap/bin/lxc", "config", "set", "oidc.issuer", issuer],
    ["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdApp.clientId],
    ["/snap/bin/lxc", "config", "set", "oidc.groups.claim", resolveLxdOidcGroupsClaim(config, "logto")],
    ["/snap/bin/lxc", "config", "set", "oidc.scopes", resolveLxdOidcScopes(config, "logto")]
  ];
  if (lxdApp.clientSecret) {
    commands.push(["/snap/bin/lxc", "config", "set", "oidc.client.secret", lxdApp.clientSecret]);
  }
  return commands;
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH, dependencies: LogtoSyncDependencies = defaultDependencies): Promise<void> {
  const config = dependencies.loadConfig(configPath, PREFIX);
  const idpMode = configString(config, "terrarium_idp_mode").toLowerCase();
  if (idpMode !== "local") {
    return;
  }

  const effectiveProvider = resolveEffectiveIdpProvider(idpMode, configString(config, "terrarium_idp_provider"));
  if (effectiveProvider !== "logto") {
    throw new Error(`Logto sync cannot run for local IDP provider ${effectiveProvider}; expected logto`);
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  if (!authDomain) {
    throw new Error("terrarium_auth_domain is empty");
  }

  const runtime = buildLogtoRuntime(config);
  const outputsPath = resolveLocalIdpOutputsPath(config);
  const managementResource = configString(config, "terrarium_logto_management_api_resource", DEFAULT_LOGTO_MANAGEMENT_API_RESOURCE);
  const managementCandidates = await readLogtoManagementAppCandidates(runtime, dependencies);
  const managementEndpoints = localLogtoManagementEndpoints(authDomain, config);

  const issuer = resolveLocalLogtoIssuer(authDomain);
  await waitForTrustedHttpsDiscovery(authDomain, issuer, dependencies);
  const managementSession = await requestLogtoManagementSession(authDomain, managementEndpoints, managementCandidates, managementResource, dependencies);
  const api: LogtoApiCall = async <T>(method: LogtoHttpMethod, path: string, body?: unknown, query?: Record<string, string>) =>
    await logtoApi<T>(authDomain, managementSession.apiEndpoint, managementSession.token, dependencies, method, path, body, query);

  await ensureEmailPasswordSignInExperience(api);
  const apps = await ensureLocalLogtoApplications(config, api, outputsPath, issuer, dependencies);
  await ensureManagementGroupProvisioning(config, api);

  if (dependencies.existsSync("/snap/bin/lxc")) {
    for (const cmd of buildLxdOidcConfigCommands(config, issuer, apps.lxd)) {
      await dependencies.runText(cmd, PREFIX);
    }
  }
}
