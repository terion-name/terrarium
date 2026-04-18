import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configString, loadConfig, readJsonFile, runAllowFailure, runText, writeIfChanged } from "./lib/common";

const PREFIX = "terrariumctl idp sync";
const DEFAULT_CONFIG_PATH = process.env.TERRARIUM_CONFIG_PATH ?? "/etc/terrarium/config.yaml";
const DEFAULT_ZITADEL_DIR = "/var/lib/terrarium/zitadel";
const DEFAULT_BOOTSTRAP_DIR = "/var/lib/terrarium/zitadel/bootstrap";
const DEFAULT_TF_DIR = "/var/lib/terrarium/zitadel/terraform";
const DEFAULT_OUTPUTS_PATH = "/etc/terrarium/zitadel-apps.json";
const DEFAULT_TOFU_IMAGE = "ghcr.io/opentofu/opentofu:1.10.6";
const WAIT_INTERVAL_MS = 5000;
const WAIT_ATTEMPTS = 36;

async function dockerRun(args: string[]): Promise<string> {
  return await runText(["docker", ...args], PREFIX);
}

async function dockerRunWithRetry(args: string[], label: string): Promise<string> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure(["docker", ...args]);
    if (result.exitCode === 0) {
      return result.stdout;
    }
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    lastError = stderr || stdout || `${label} failed`;
    const combined = `${stdout}\n${stderr}`;
    if (!combined.includes("issuer does not match")) {
      throw new Error(lastError);
    }
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${label}: ${lastError}`);
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

async function waitForHttpsDiscovery(authDomain: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    const result = await runAllowFailure([
      "curl",
      "-fsS",
      `https://${authDomain}/.well-known/openid-configuration`
    ]);
    if (result.exitCode === 0) {
      return;
    }
    lastError = result.stderr.trim() || result.stdout.trim() || "OIDC discovery is not reachable yet";
    await Bun.sleep(WAIT_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for HTTPS OIDC discovery on ${authDomain}: ${lastError}`);
}

function terraformResourceCount(tfDir: string): number {
  const statePath = join(tfDir, "terraform.tfstate");
  if (!existsSync(statePath)) {
    return 0;
  }
  const state = readJsonFile<Record<string, unknown>>(statePath, {});
  return Array.isArray(state.resources) ? state.resources.length : 0;
}

function recoverTerraformState(tfDir: string): void {
  const statePath = join(tfDir, "terraform.tfstate");
  const backupPath = join(tfDir, "terraform.tfstate.backup");
  if (!existsSync(statePath) || !existsSync(backupPath)) {
    return;
  }

  const state = readJsonFile<Record<string, unknown>>(statePath, {});
  const backup = readJsonFile<Record<string, unknown>>(backupPath, {});
  const stateResources = Array.isArray(state.resources) ? state.resources.length : 0;
  const backupResources = Array.isArray(backup.resources) ? backup.resources.length : 0;
  if (stateResources === 0 && backupResources > 0) {
    copyFileSync(backupPath, statePath);
  }
}

type ZitadelProject = { id: string; name: string };
type ZitadelApp = { id: string; name: string };
type ZitadelAction = { id: string; name: string; script?: string };
type ZitadelFlowTrigger = { triggerType?: { id?: string }; actions?: ZitadelAction[] };
type ZitadelFlow = { flow?: { triggerActions?: ZitadelFlowTrigger[] } };
type ZitadelUser = {
  userId?: string;
  preferredLoginName?: string;
  loginNames?: string[];
  human?: { email?: { email?: string } };
};
type ZitadelUserGrant = { id: string; userId: string; projectId: string; roleKeys?: string[] };

const TERRARIUM_GROUPS_ACTION_NAME = "terrariumGroups";
const TERRARIUM_GROUPS_ACTION_SCRIPT = `function terrariumGroups(ctx, api) {
  var groups = [];
  if (!ctx || !ctx.v1 || !ctx.v1.user || !ctx.v1.user.grants || !ctx.v1.user.grants.grants) {
    api.v1.claims.setClaim('groups', groups);
    return;
  }
  for (var i = 0; i < ctx.v1.user.grants.grants.length; i++) {
    var grant = ctx.v1.user.grants.grants[i];
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
  const cmd = ["curl", "-fsS", "-X", method, "-H", `Authorization: Bearer ${pat}`, "-H", "Content-Type: application/json", url.toString()];
  if (body !== undefined && method !== "GET") {
    cmd.push("-d", JSON.stringify(body));
  }
  const stdout = await runText(cmd, PREFIX);
  return JSON.parse(stdout) as T;
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
  const updateResult = await runAllowFailure(
    [
      "curl",
      "-fsS",
      "-X",
      "PUT",
      "-H",
      `Authorization: Bearer ${pat}`,
      "-H",
      "Content-Type: application/json",
      `https://${authDomain}/management/v1/projects/${projectId}/roles/${encodeURIComponent(adminGroup)}`,
      "-d",
      JSON.stringify({ displayName: "Terrarium Management Admin", group: "Terrarium" })
    ]
  );
  if (updateResult.exitCode === 0) {
    return;
  }
  const createResult = await runAllowFailure(
    [
      "curl",
      "-fsS",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${pat}`,
      "-H",
      "Content-Type: application/json",
      `https://${authDomain}/management/v1/projects/${projectId}/roles`,
      "-d",
      JSON.stringify({ roleKey: adminGroup, displayName: "Terrarium Management Admin", group: "Terrarium" })
    ]
  );
  if (createResult.exitCode !== 0) {
    throw new Error(createResult.stderr.trim() || createResult.stdout.trim() || "failed to ensure Terrarium project role");
  }
}

async function lookupUserId(authDomain: string, pat: string, loginName: string): Promise<string> {
  const users = await zitadelApi<{ result?: ZitadelUser[] }>(authDomain, pat, "POST", "/v2/users", {});
  const allUsers = users.result ?? [];
  const matchingUser =
    allUsers.find((user) => user.preferredLoginName === loginName) ??
    allUsers.find((user) => (user.loginNames ?? []).includes(loginName)) ??
    allUsers.find((user) => user.human?.email?.email === loginName);
  if (matchingUser?.userId) {
    return matchingUser.userId;
  }

  const humanUsers = allUsers.filter((user) => typeof user.userId === "string" && typeof user.human?.email?.email === "string");
  if (humanUsers.length === 1 && humanUsers[0]?.userId) {
    return humanUsers[0].userId;
  }

  throw new Error(`failed to find ZITADEL user for login name ${loginName}`);
}

async function ensureUserGrant(authDomain: string, pat: string, userId: string, projectId: string, adminGroup: string): Promise<void> {
  const grants = await zitadelApi<{ result?: ZitadelUserGrant[] }>(authDomain, pat, "POST", "/management/v1/users/grants/_search", {});
  const existing = (grants.result ?? []).find((grant) => grant.userId === userId && grant.projectId === projectId);
  if (existing?.roleKeys?.includes(adminGroup)) {
    return;
  }
  await zitadelApi(authDomain, pat, "POST", `/management/v1/users/${userId}/grants`, {
    projectId,
    roleKeys: [adminGroup]
  });
}

async function ensureGroupsAction(authDomain: string, pat: string): Promise<string> {
  const actions = await zitadelApi<{ result?: ZitadelAction[] }>(authDomain, pat, "POST", "/management/v1/actions/_search", {});
  const existing = (actions.result ?? []).find((action) => action.name === TERRARIUM_GROUPS_ACTION_NAME);
  if (existing?.id) {
    if ((existing.script ?? "").trim() !== TERRARIUM_GROUPS_ACTION_SCRIPT.trim()) {
      await zitadelApi(authDomain, pat, "PUT", `/management/v1/actions/${existing.id}`, {
        name: TERRARIUM_GROUPS_ACTION_NAME,
        script: TERRARIUM_GROUPS_ACTION_SCRIPT,
        timeout: "10s",
        allowedToFail: false
      });
    }
    return existing.id;
  }

  const created = await zitadelApi<{ id?: string }>(authDomain, pat, "POST", "/management/v1/actions", {
    name: TERRARIUM_GROUPS_ACTION_NAME,
    script: TERRARIUM_GROUPS_ACTION_SCRIPT,
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

async function ensureManagementGroupProvisioning(authDomain: string, pat: string, adminLoginName: string, adminGroup: string): Promise<void> {
  const projectId = await lookupProjectId(authDomain, pat);
  await ensureProjectRole(authDomain, pat, projectId, adminGroup);
  const userId = await lookupUserId(authDomain, pat, adminLoginName);
  await ensureUserGrant(authDomain, pat, userId, projectId, adminGroup);
  const actionId = await ensureGroupsAction(authDomain, pat);
  await ensureFlowTrigger(authDomain, pat, "2", "4", actionId);
  await ensureFlowTrigger(authDomain, pat, "2", "5", actionId);
}

async function importExistingResources(commonArgs: string[], authDomain: string, bootstrapDir: string, tfDir: string): Promise<void> {
  if (terraformResourceCount(tfDir) > 0) {
    return;
  }

  const patPath = join(bootstrapDir, "admin-sa.pat");
  if (!existsSync(patPath)) {
    return;
  }
  const pat = readFileSync(patPath, "utf8").trim();
  if (!pat) {
    return;
  }

  const projects = await zitadelApi<{ result?: ZitadelProject[] }>(authDomain, pat, "POST", "/management/v1/projects/_search", {});
  const project = (projects.result ?? []).find((entry) => entry.name === "Terrarium");
  if (!project) {
    return;
  }

  await dockerRun(["run", ...commonArgs.slice(1), "import", "-input=false", "zitadel_project.terrarium", project.id]);
  const apps = await zitadelApi<{ result?: ZitadelApp[] }>(
    authDomain,
    pat,
    "POST",
    `/management/v1/projects/${project.id}/apps/_search`,
    {}
  );
  const byName = new Map((apps.result ?? []).map((entry) => [entry.name, entry.id]));
  const lxdId = byName.get("terrarium-lxd");
  const cockpitId = byName.get("terrarium-cockpit");
  const routesId = byName.get("terrarium-routes");
  if (lxdId) {
    await dockerRun(["run", ...commonArgs.slice(1), "import", "-input=false", "zitadel_application_oidc.lxd", `${lxdId}:${project.id}`]);
  }
  if (cockpitId) {
    await dockerRun(["run", ...commonArgs.slice(1), "import", "-input=false", "zitadel_application_oidc.cockpit", `${cockpitId}:${project.id}`]);
  }
  if (routesId) {
    await dockerRun(["run", ...commonArgs.slice(1), "import", "-input=false", "zitadel_application_oidc.routes", `${routesId}:${project.id}`]);
  }
}

export async function idpSyncCmd(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const config = loadConfig(configPath, PREFIX);
  if (configString(config, "terrarium_idp_mode") !== "local") {
    return;
  }

  const authDomain = configString(config, "terrarium_auth_domain");
  const zitadelDir = configString(config, "terrarium_zitadel_dir") || DEFAULT_ZITADEL_DIR;
  const bootstrapDir = configString(config, "terrarium_zitadel_bootstrap_dir") || DEFAULT_BOOTSTRAP_DIR;
  const tfDir = configString(config, "terrarium_zitadel_tf_dir") || DEFAULT_TF_DIR;
  const outputsPath = configString(config, "terrarium_zitadel_outputs_path") || DEFAULT_OUTPUTS_PATH;
  const tofuImage = configString(config, "terrarium_zitadel_tofu_image") || DEFAULT_TOFU_IMAGE;

  if (!authDomain) {
    throw new Error("terrarium_auth_domain is empty");
  }
  if (!existsSync(tfDir)) {
    throw new Error(`terraform directory not found: ${tfDir}`);
  }

  await waitForFile(`${bootstrapDir}/admin-sa.json`, "bootstrap machine key");
  await waitForFile(`${bootstrapDir}/login-client.pat`, "login client PAT");
  await waitForApiReady(zitadelDir);
  await waitForHttpsDiscovery(authDomain);
  recoverTerraformState(tfDir);

  const commonArgs = [
    "run",
    "--rm",
    "--network",
    "host",
    "--add-host",
    `${authDomain}:127.0.0.1`,
    "-v",
    `${tfDir}:/workspace`,
    "-v",
    `${bootstrapDir}:/secrets:ro`,
    "-w",
    "/workspace",
    tofuImage
  ];

  await dockerRunWithRetry([...commonArgs, "init", "-input=false"], "OpenTofu init");
  await importExistingResources(commonArgs, authDomain, bootstrapDir, tfDir);
  await dockerRunWithRetry([...commonArgs, "apply", "-input=false", "-auto-approve"], "OpenTofu apply");
  const outputsJson = await dockerRun([...commonArgs, "output", "-json"]);
  writeIfChanged(outputsPath, outputsJson.endsWith("\n") ? outputsJson : `${outputsJson}\n`);

  const outputs = readJsonFile<Record<string, { value?: string }>>(outputsPath, {});
  const lxdClientId = outputs.lxd_client_id?.value ?? "";
  const adminPat = readFileSync(join(bootstrapDir, "admin-sa.pat"), "utf8").trim();
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
  await ensureManagementGroupProvisioning(authDomain, adminPat, adminLoginName, adminGroup);
  if (lxdClientId && existsSync("/snap/bin/lxc")) {
    const issuer = configString(config, "terrarium_oidc_issuer") || `https://${authDomain}`;
    await runText(["/snap/bin/lxc", "config", "set", "oidc.issuer", issuer], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.client.id", lxdClientId], PREFIX);
    await runText(["/snap/bin/lxc", "config", "set", "oidc.groups.claim", "groups"], PREFIX);
  }
}
