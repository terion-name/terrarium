import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged } from "./lib/common";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const DEFAULT_ZITADEL_INSTANCE_NAME = "terrarium-idp";
const DEFAULT_ZITADEL_DIR = "/var/lib/terrarium/zitadel";
const DEFAULT_BOOTSTRAP_DIR = "/var/lib/terrarium/zitadel/bootstrap";
const DEFAULT_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
const DEFAULT_SYSTEM_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const WAIT_INTERVAL_MS = 5000;
const WAIT_ATTEMPTS = 36;
const ZITADEL_HTTP_STATUS_MARKER = "__terrarium_http_status__:";

export function isRetriableZitadelApiError(message: string): boolean {
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
    "errors.project.role.notfound",
    "http 502",
    "http 503",
    "http 504"
  ].some((needle) => lowered.includes(needle));
}

async function waitForFile(path: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${label}: ${path}`);
}

async function lxcInstanceExists(instanceName: string): Promise<boolean> {
  if (!Bun.which("lxc")) {
    return false;
  }
  return (await runAllowFailure(["lxc", "info", instanceName])).exitCode === 0;
}

async function waitForContainerFile(instanceName: string, path: string, label: string): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(["lxc", "exec", instanceName, "--", "test", "-f", path]);
    if (result.exitCode === 0) {
      return;
    }
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${label}: ${instanceName}${path}`);
}

async function readContainerFile(instanceName: string, path: string): Promise<string> {
  return await runText(["lxc", "exec", instanceName, "--", "cat", path], PREFIX);
}

function trustedCaArgs(): string[] {
  return existsSync(DEFAULT_SYSTEM_CA_BUNDLE_PATH) ? ["--cacert", DEFAULT_SYSTEM_CA_BUNDLE_PATH] : [];
}

async function waitForApiReady(stackDir: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(
      [
        "docker",
        "compose",
        "--project-name",
        "terrarium-zitadel",
        "-f",
        `${stackDir}/docker-compose.yml`,
        "exec",
        "-T",
        "zitadel-api",
        "/app/zitadel",
        "ready"
      ],
      { cwd: stackDir }
    );
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "container is not ready yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ZITADEL API readiness: ${lastError}`);
}

async function waitForContainerApiReady(instanceName: string, stackDir: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure([
      "lxc",
      "exec",
      instanceName,
      "--",
      "docker",
      "compose",
      "--project-name",
      "terrarium-zitadel",
      "-f",
      `${stackDir}/docker-compose.yml`,
      "exec",
      "-T",
      "zitadel-api",
      "/app/zitadel",
      "ready"
    ]);
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "container is not ready yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ZITADEL API readiness in ${instanceName}: ${lastError}`);
}

async function waitForTrustedHttpsDiscovery(authDomain: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const cmd = [
      "curl",
      "-fsS",
      "--noproxy",
      "*",
      ...trustedCaArgs(),
      "--resolve",
      `${authDomain}:443:127.0.0.1`,
      "--connect-timeout",
      "10",
      "--max-time",
      "20",
      `https://${authDomain}/.well-known/openid-configuration`
    ];
    const result = await runAllowFailure(cmd);
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "OIDC discovery is not reachable yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for HTTPS OIDC discovery on ${authDomain}: ${lastError}`);
}

function zitadelCurlBase(authDomain: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, headerPath: string): string[] {
  const cmd = ["curl", "-sS", "--noproxy", "*", ...trustedCaArgs()];
  cmd.push(
    "--resolve",
    `${authDomain}:443:127.0.0.1`,
    "--connect-timeout",
    "10",
    "--max-time",
    "20",
    "--write-out",
    `\n${ZITADEL_HTTP_STATUS_MARKER}%{http_code}`,
    "-X",
    method,
    "-H",
    `@${headerPath}`,
    url
  );
  return cmd;
}

function writeZitadelHeaderFile(pat: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-zitadel-api-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "headers");
  writeFileSync(path, `Authorization: Bearer ${pat}\nContent-Type: application/json\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return { dir, path };
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

export function isZitadelAlreadyExistsError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("already") && lowered.includes("exist");
}

function compactZitadelBody(body: string): string {
  return body.trim().replace(/\s+/g, " ").slice(0, 2000) || "<empty>";
}

function formatZitadelHttpFailure(method: string, path: string, status: number, body: string): string {
  return `ZITADEL API ${method} ${path} returned HTTP ${status}: ${compactZitadelBody(body)}`;
}

type ZitadelProject = { id: string; name: string };
type ZitadelApp = {
  id?: string;
  name?: string;
  oidcConfig?: { clientId?: string };
  oidc_config?: { clientId?: string };
  apiConfig?: { clientId?: string };
  clientId?: string;
};
type ZitadelAction = { id: string; name: string; script?: string };
type ZitadelFlowTrigger = { triggerType?: { id?: string }; actions?: ZitadelAction[] };
type ZitadelFlow = { flow?: { triggerActions?: ZitadelFlowTrigger[] } };
type ZitadelUser = { user?: { id?: string } };
type ZitadelUserGrant = { id: string; userId: string; projectId: string; roleKeys?: string[] };
type ZitadelApiCall = <T>(
  authDomain: string,
  pat: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  query?: Record<string, string>
) => Promise<T>;

const TERRARIUM_GROUPS_ACTION_NAME = "terrariumGroups";
export function terrariumGroupsActionScript(projectId: string): string {
  return `function terrariumGroups(ctx, api) {
  var groups = [];
  var terrariumProjectId = ${JSON.stringify(projectId)};
  if (!ctx || !ctx.v1 || !ctx.v1.user || !ctx.v1.user.grants || !ctx.v1.user.grants.grants) {
    api.v1.claims.setClaim('groups', groups);
    return;
  }
  for (var i = 0; i < ctx.v1.user.grants.grants.length; i++) {
    var grant = ctx.v1.user.grants.grants[i];
    var grantProjectId = grant && (grant.projectId || grant.projectID || grant.project_id);
    if (grantProjectId !== terrariumProjectId) {
      continue;
    }
    if (!grant || !grant.roles) {
      continue;
    }
    for (var j = 0; j < grant.roles.length; j++) {
      var role = grant.roles[j];
      if (groups.indexOf(role) === -1) {
        groups.push(role);
      }
    }
  }
  api.v1.claims.setClaim('groups', groups);
}`;
}

type LocalOidcAppSpec = {
  outputPrefix: "cockpit" | "lxd" | "routes";
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  appType: "OIDC_APP_TYPE_WEB" | "OIDC_APP_TYPE_NATIVE";
  authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC" | "OIDC_AUTH_METHOD_TYPE_NONE";
  grantTypes: string[];
  includeSecret: boolean;
};

type LocalOidcApp = {
  appId: string;
  clientId: string;
  clientSecret?: string;
};

async function zitadelApi<T>(
  authDomain: string,
  pat: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<T> {
  const url = new URL(`https://${authDomain}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  const headers = writeZitadelHeaderFile(pat);
  const cmd = zitadelCurlBase(authDomain, method, url.toString(), headers.path);
  const stdin = body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined;
  if (body !== undefined && method !== "GET") {
    cmd.push("--data-binary", "@-");
  }

  let lastError = "";
  try {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      const result = await runAllowFailure(cmd, { stdin });
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
      await Bun.sleep(WAIT_INTERVAL_MS);
    }

    throw new Error(`timed out waiting for ZITADEL API ${method} ${path}: ${lastError}`);
  } finally {
    rmSync(headers.dir, { recursive: true, force: true });
  }
}

async function lookupProjectId(authDomain: string, pat: string): Promise<string> {
  const projects = await zitadelApi<{ result?: ZitadelProject[] }>(authDomain, pat, "POST", "/management/v1/projects/_search", {});
  const project = (projects.result ?? []).find((entry) => entry.name === "Terrarium");
  if (!project?.id) {
    throw new Error("failed to find Terrarium project in ZITADEL");
  }
  return project.id;
}

async function ensureProjectRole(authDomain: string, pat: string, projectId: string, adminGroup: string): Promise<void> {
  const roleBody = { roleKey: adminGroup, displayName: "Terrarium Management Admin", group: "Terrarium" };
  try {
    await zitadelApi(authDomain, pat, "POST", `/management/v1/projects/${projectId}/roles`, roleBody);
  } catch (error) {
    if (!isZitadelAlreadyExistsError(String(error))) {
      throw error;
    }
  }
  await zitadelApi(authDomain, pat, "PUT", `/management/v1/projects/${projectId}/roles/${encodeURIComponent(adminGroup)}`, {
    displayName: roleBody.displayName,
    group: roleBody.group
  });
}

export async function lookupUserId(
  authDomain: string,
  pat: string,
  loginName: string,
  api: ZitadelApiCall = zitadelApi
): Promise<string> {
  const user = await api<ZitadelUser>(
    authDomain,
    pat,
    "GET",
    "/management/v1/global/users/_by_login_name",
    undefined,
    { loginName }
  );
  if (!user.user?.id) {
    throw new Error(`failed to find ZITADEL user for login name ${loginName}`);
  }
  return user.user.id;
}

async function ensureUserGrant(authDomain: string, pat: string, userId: string, projectId: string, adminGroup: string): Promise<void> {
  const grants = await zitadelApi<{ result?: ZitadelUserGrant[] }>(authDomain, pat, "POST", "/management/v1/users/grants/_search", {});
  const existing = (grants.result ?? []).find((grant) => grant.userId === userId && grant.projectId === projectId);
  if (existing?.roleKeys?.includes(adminGroup)) {
    return;
  }
  if (existing?.id) {
    await zitadelApi(authDomain, pat, "PUT", `/management/v1/users/${userId}/grants/${existing.id}`, {
      roleKeys: mergedRoleKeys(existing.roleKeys ?? [], adminGroup)
    });
    return;
  }
  await zitadelApi(authDomain, pat, "POST", `/management/v1/users/${userId}/grants`, {
    projectId,
    roleKeys: [adminGroup]
  });
}

export function mergedRoleKeys(existingRoleKeys: string[], requiredRoleKey: string): string[] {
  return Array.from(new Set([...existingRoleKeys, requiredRoleKey])).sort();
}

async function ensureGroupsAction(authDomain: string, pat: string, projectId: string): Promise<string> {
  const script = terrariumGroupsActionScript(projectId);
  const actions = await zitadelApi<{ result?: ZitadelAction[] }>(authDomain, pat, "POST", "/management/v1/actions/_search", {});
  const existing = (actions.result ?? []).find((action) => action.name === TERRARIUM_GROUPS_ACTION_NAME);
  if (existing?.id) {
    if ((existing.script ?? "").trim() !== script.trim()) {
      await zitadelApi(authDomain, pat, "PUT", `/management/v1/actions/${existing.id}`, {
        name: TERRARIUM_GROUPS_ACTION_NAME,
        script,
        timeout: "10s",
        allowedToFail: false
      });
    }
    return existing.id;
  }

  const created = await zitadelApi<{ id?: string }>(authDomain, pat, "POST", "/management/v1/actions", {
    name: TERRARIUM_GROUPS_ACTION_NAME,
    script,
    timeout: "10s",
    allowedToFail: false
  });
  if (!created.id) {
    throw new Error("failed to create Terrarium groups action");
  }
  return created.id;
}

async function ensureFlowTrigger(authDomain: string, pat: string, flowType: string, triggerType: string, actionId: string): Promise<void> {
  const flow = await zitadelApi<ZitadelFlow>(authDomain, pat, "GET", `/management/v1/flows/${flowType}`);
  const trigger = (flow.flow?.triggerActions ?? []).find((entry) => entry.triggerType?.id === triggerType);
  const currentIds = (trigger?.actions ?? []).map((entry) => entry.id).filter(Boolean);
  const nextIds = Array.from(new Set([...currentIds, actionId]));
  if (nextIds.length === currentIds.length) {
    return;
  }
  await zitadelApi(authDomain, pat, "POST", `/management/v1/flows/${flowType}/trigger/${triggerType}`, { actionIds: nextIds });
}

function oidcAppConfigBody(authDomain: string, spec: LocalOidcAppSpec): Record<string, unknown> {
  return {
    redirectUris: spec.redirectUris,
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: spec.grantTypes,
    appType: spec.appType,
    authMethodType: spec.authMethodType,
    postLogoutRedirectUris: spec.postLogoutRedirectUris,
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
  };
}

export function localOidcAppSpecs(config: Record<string, unknown>, authDomain: string): LocalOidcAppSpec[] {
  const manageDomain = configString(config, "terrarium_manage_domain");
  const proxyDomain = configString(config, "terrarium_proxy_domain");
  const lxdDomain = configString(config, "terrarium_lxd_domain");
  return [
    {
      outputPrefix: "cockpit",
      name: "terrarium-cockpit",
      redirectUris: [`https://${manageDomain}/oauth2/callback`, `https://${proxyDomain}/oauth2/callback`],
      postLogoutRedirectUris: [`https://${manageDomain}/`, `https://${proxyDomain}/`],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      includeSecret: true
    },
    {
      outputPrefix: "lxd",
      name: "terrarium-lxd",
      redirectUris: [`https://${lxdDomain}/oidc/callback`],
      postLogoutRedirectUris: [`https://${lxdDomain}/`],
      appType: "OIDC_APP_TYPE_NATIVE",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN", "OIDC_GRANT_TYPE_DEVICE_CODE"],
      includeSecret: false
    },
    {
      outputPrefix: "routes",
      name: "terrarium-routes",
      redirectUris: [`https://${manageDomain}/oauth2/app/callback`],
      postLogoutRedirectUris: [`https://${manageDomain}/`],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      includeSecret: true
    }
  ];
}

function oidcClientId(app: ZitadelApp): string {
  return app.oidcConfig?.clientId ?? app.oidc_config?.clientId ?? app.apiConfig?.clientId ?? app.clientId ?? "";
}

async function getZitadelApp(authDomain: string, pat: string, projectId: string, appId: string): Promise<ZitadelApp> {
  const response = await zitadelApi<{ app?: ZitadelApp }>(authDomain, pat, "GET", `/management/v1/projects/${projectId}/apps/${appId}`);
  return response.app ?? {};
}

async function findZitadelAppByName(
  authDomain: string,
  pat: string,
  projectId: string,
  name: string,
  preferredClientId: string
): Promise<ZitadelApp | null> {
  const apps = await zitadelApi<{ result?: ZitadelApp[] }>(authDomain, pat, "POST", `/management/v1/projects/${projectId}/apps/_search`, {});
  const candidates = (apps.result ?? []).filter((entry) => entry.name === name && entry.id).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (candidates.length === 0) {
    return null;
  }

  const detailed: ZitadelApp[] = [];
  for (const app of candidates) {
    const appId = app.id ?? "";
    if (!appId) {
      continue;
    }
    const details = await getZitadelApp(authDomain, pat, projectId, appId);
    detailed.push({ ...app, ...details, id: details.id ?? app.id, name: details.name ?? app.name });
  }
  return detailed.find((entry) => preferredClientId && oidcClientId(entry) === preferredClientId) ?? detailed[0] ?? candidates[0] ?? null;
}

async function ensureLocalProject(authDomain: string, pat: string): Promise<string> {
  const projects = await zitadelApi<{ result?: ZitadelProject[] }>(authDomain, pat, "POST", "/management/v1/projects/_search", {});
  const existing = (projects.result ?? []).find((entry) => entry.name === "Terrarium");
  if (existing?.id) {
    return existing.id;
  }

  const created = await zitadelApi<{ id?: string }>(authDomain, pat, "POST", "/management/v1/projects", {
    name: "Terrarium",
    projectRoleAssertion: true,
    projectRoleCheck: true,
    hasProjectCheck: true,
    privateLabelingSetting: "PRIVATE_LABELING_SETTING_ENFORCE_PROJECT_RESOURCE_OWNER_POLICY"
  });
  if (!created.id) {
    throw new Error("failed to create Terrarium project in ZITADEL");
  }
  return created.id;
}

async function ensureLocalOidcApp(
  authDomain: string,
  pat: string,
  projectId: string,
  spec: LocalOidcAppSpec,
  previousOutputs: Record<string, { value?: string }>
): Promise<LocalOidcApp> {
  const previousClientId = previousOutputs[`${spec.outputPrefix}_client_id`]?.value?.trim() ?? "";
  const previousSecret = previousOutputs[`${spec.outputPrefix}_client_secret`]?.value?.trim() ?? "";
  const existing = await findZitadelAppByName(authDomain, pat, projectId, spec.name, previousClientId);
  const configBody = oidcAppConfigBody(authDomain, spec);

  let appId = existing?.id ?? "";
  let clientId = existing ? oidcClientId(existing) : "";
  let clientSecret = "";

  if (!appId) {
    const created = await zitadelApi<{ appId?: string; clientId?: string; clientSecret?: string }>(
      authDomain,
      pat,
      "POST",
      `/management/v1/projects/${projectId}/apps/oidc`,
      { name: spec.name, ...configBody }
    );
    appId = created.appId ?? "";
    clientId = created.clientId ?? "";
    clientSecret = created.clientSecret ?? "";
  } else {
    await zitadelApi(authDomain, pat, "PUT", `/management/v1/projects/${projectId}/apps/${appId}/oidc_config`, configBody);
  }

  if (!appId || !clientId) {
    throw new Error(`failed to ensure ${spec.name} OIDC app`);
  }

  if (spec.includeSecret) {
    if (previousClientId === clientId && previousSecret) {
      clientSecret = previousSecret;
    } else if (!clientSecret) {
      const regenerated = await zitadelApi<{ clientSecret?: string }>(
        authDomain,
        pat,
        "PUT",
        `/management/v1/projects/${projectId}/apps/${appId}/oidc_client_secret`
      );
      clientSecret = regenerated.clientSecret ?? "";
    }
    if (!clientSecret) {
      throw new Error(`failed to obtain client secret for ${spec.name}`);
    }
  }

  return { appId, clientId, clientSecret };
}

export function buildLocalIdpOutputs(projectId: string, apps: Record<LocalOidcAppSpec["outputPrefix"], LocalOidcApp>, authDomain: string): string {
  const output = {
    cockpit_client_id: { sensitive: true, type: "string", value: apps.cockpit.clientId },
    cockpit_client_secret: { sensitive: true, type: "string", value: apps.cockpit.clientSecret ?? "" },
    issuer: { sensitive: false, type: "string", value: `https://${authDomain}/` },
    lxd_client_id: { sensitive: true, type: "string", value: apps.lxd.clientId },
    project_id: { sensitive: false, type: "string", value: projectId },
    routes_client_id: { sensitive: true, type: "string", value: apps.routes.clientId },
    routes_client_secret: { sensitive: true, type: "string", value: apps.routes.clientSecret ?? "" }
  };
  return `${JSON.stringify(output, null, 2)}\n`;
}

async function ensureLocalIdpApplications(
  config: Record<string, unknown>,
  authDomain: string,
  pat: string,
  outputsPath: string
): Promise<Record<LocalOidcAppSpec["outputPrefix"], LocalOidcApp> & { projectId: string }> {
  const previousOutputs = readJsonFile<Record<string, { value?: string }>>(outputsPath, {});
  const projectId = await ensureLocalProject(authDomain, pat);
  const apps = {} as Record<LocalOidcAppSpec["outputPrefix"], LocalOidcApp>;
  for (const spec of localOidcAppSpecs(config, authDomain)) {
    apps[spec.outputPrefix] = await ensureLocalOidcApp(authDomain, pat, projectId, spec, previousOutputs);
  }
  writeIfChanged(outputsPath, buildLocalIdpOutputs(projectId, apps, authDomain), { mode: 0o600 });
  return { ...apps, projectId };
}

async function ensureManagementGroupProvisioning(authDomain: string, pat: string, adminLoginName: string, adminGroup: string): Promise<void> {
  const projectId = await lookupProjectId(authDomain, pat);
  await ensureProjectRole(authDomain, pat, projectId, adminGroup);
  const userId = await lookupUserId(authDomain, pat, adminLoginName);
  await ensureUserGrant(authDomain, pat, userId, projectId, adminGroup);
  const actionId = await ensureGroupsAction(authDomain, pat, projectId);
  await ensureFlowTrigger(authDomain, pat, "2", "4", actionId);
  await ensureFlowTrigger(authDomain, pat, "2", "5", actionId);
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (configString(config, "terrarium_idp_mode") !== "local") {
    return;
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  const instanceName = configString(config, "terrarium_zitadel_instance_name", DEFAULT_ZITADEL_INSTANCE_NAME);
  const zitadelDir = configString(config, "terrarium_zitadel_dir") || DEFAULT_ZITADEL_DIR;
  const bootstrapDir = configString(config, "terrarium_zitadel_bootstrap_dir") || DEFAULT_BOOTSTRAP_DIR;
  const outputsPath = configString(config, "terrarium_zitadel_outputs_path") || DEFAULT_OUTPUTS_PATH;

  if (!authDomain) {
    throw new Error("terrarium_auth_domain is empty");
  }

  const useLxdInstance = await lxcInstanceExists(instanceName);
  if (useLxdInstance) {
    await waitForContainerFile(instanceName, `${bootstrapDir}/admin-sa.json`, "bootstrap machine key");
    await waitForContainerFile(instanceName, `${bootstrapDir}/login-client.pat`, "login client PAT");
    await waitForContainerApiReady(instanceName, zitadelDir);
  } else {
    await waitForFile(`${bootstrapDir}/admin-sa.json`, "bootstrap machine key");
    await waitForFile(`${bootstrapDir}/login-client.pat`, "login client PAT");
    await waitForApiReady(zitadelDir);
  }
  await waitForTrustedHttpsDiscovery(authDomain);

  const adminPat = (
    useLxdInstance ? await readContainerFile(instanceName, `${bootstrapDir}/admin-sa.pat`) : readFileSync(join(bootstrapDir, "admin-sa.pat"), "utf8")
  ).trim();
  const adminLoginName = configString(config, "terrarium_zitadel_admin_email") || configString(config, "terrarium_email");
  const adminGroup = configString(config, "terrarium_admin_group", "terrarium-admins");
  if (!adminPat) {
    throw new Error("bootstrap PAT is empty");
  }
  if (!adminLoginName) {
    throw new Error("bootstrap admin login name is empty");
  }
  if (!adminGroup) {
    throw new Error("terrarium_admin_group is empty");
  }
  const localApps = await ensureLocalIdpApplications(config, authDomain, adminPat, outputsPath);
  const lxdClientId = localApps.lxd.clientId;
  await ensureManagementGroupProvisioning(authDomain, adminPat, adminLoginName, adminGroup);
  if (lxdClientId && existsSync("/snap/bin/lxc")) {
    const issuer = configString(config, "terrarium_oidc_issuer") || `https://${authDomain}`;
    await runText(["/snap/bin/lxc", "config", "set", "oidc.issuer", issuer], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdClientId], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.groups.claim", "groups"], PREFIX);
  }
}
