import { randomBytes } from "node:crypto";
import type { DomainBundle, ExternalOidcFixture, IntegrationConfig, OidcTestUser } from "../types";
import { IntegrationLogger } from "../lib/logger";
import type {
  ExternalOidcCleanupStep,
  IntegrationOidcFixtureOptions,
  IntegrationOidcFixtureProgress,
  IntegrationOidcFixtureProgressHandler,
  IntegrationOidcProvider
} from "./external-oidc";

type ProjectResponse = { id?: string };
type UserResponse = { userId?: string };
type AppResponse = { appId?: string; clientId?: string; clientSecret?: string };
type SearchProjectResult = { result?: Array<{ id?: string; name?: string }> };
type SearchAppResult = { result?: Array<{ id?: string; name?: string }> };
type SearchUserResult = {
  result?: Array<{
    id?: string;
    userId?: string;
    userName?: string;
    preferredLoginName?: string;
    human?: {
      userId?: string;
      userName?: string;
      preferredLoginName?: string;
      email?: { email?: string };
      profile?: { email?: string };
    };
  }>;
};
type ActionResult = { result?: Array<{ id?: string; name?: string; script?: string }> };
type Flow = { flow?: { triggerActions?: Array<{ triggerType?: { id?: string }; actions?: Array<{ id?: string }> }> } };
export type ZitadelFixtureProgress = IntegrationOidcFixtureProgress;
export type ZitadelFixtureProgressHandler = IntegrationOidcFixtureProgressHandler;

const GROUPS_ACTION_NAME = "groupsClaim";
const DENIED_ROUTE_ROLE = "bystanders";
const INTEGRATION_PROJECT_NAME_PATTERN = /^terrarium-(?:gha|local)-[a-z0-9-]+$/;
const INTEGRATION_USER_EMAIL_PATTERN = /^(?:admin|agent|denied)\+(?:gha|local)-[a-z0-9-]+@example\.net$/;
const GROUPS_ACTION_SCRIPT = `function groupsClaim(ctx, api) {
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

function generateComplexPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let suffix = "";
  const bytes = randomBytes(12);
  for (const byte of bytes) {
    suffix += alphabet[byte % alphabet.length];
  }
  return `Aa1!${suffix}`;
}

function normalizeRouteCallbackUri(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (/^https:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}/oauth2/callback`;
}

export function buildZitadelCloudRedirectUris(domains: DomainBundle, routeCallbackUris: string[] = [], extraDomains: DomainBundle[] = []): string[] {
  return [
    ...new Set([
      ...buildZitadelCloudManagementRedirectUris(domains, routeCallbackUris, extraDomains),
      ...buildZitadelCloudLxdRedirectUris(domains, extraDomains)
    ])
  ];
}

export function buildZitadelCloudManagementRedirectUris(
  domains: DomainBundle,
  routeCallbackUris: string[] = [],
  extraDomains: DomainBundle[] = []
): string[] {
  const redirectUris = new Set<string>();
  for (const domainBundle of [domains, ...extraDomains]) {
    redirectUris.add(`https://${domainBundle.manage}/oauth2/callback`);
    redirectUris.add(`https://${domainBundle.proxy}/oauth2/callback`);
    redirectUris.add(`https://${domainBundle.manage}/oauth2/app/callback`);
  }
  for (const callbackUri of routeCallbackUris) {
    const normalized = normalizeRouteCallbackUri(callbackUri);
    if (normalized) {
      redirectUris.add(normalized);
    }
  }
  return [...redirectUris];
}

export function buildZitadelCloudLxdRedirectUris(domains: DomainBundle, extraDomains: DomainBundle[] = []): string[] {
  return [...new Set([domains, ...extraDomains].map((domainBundle) => `https://${domainBundle.lxd}/oidc/callback`))];
}

function isRetryableZitadelStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Creates per-run ZITADEL Cloud fixtures for Terrarium external OIDC tests.
 *
 * The fixture matches Terrarium’s current expectation of a flat `groups` claim
 * so the same admin and route-authorization checks work against cloud and local
 * ZITADEL setups.
 */
export class ZitadelCloudProvider implements IntegrationOidcProvider {
  readonly provider = "zitadel" as const;
  readonly issuer: string;
  private readonly pat: string;
  private readonly orgId: string;
  private readonly logger: IntegrationLogger;
  private readonly requestTimeoutMs = 45000;
  private readonly maxAttempts = 8;
  private oidcClientReadyAttempts = 24;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.issuer = config.zitadelCloudIssuer.replace(/\/$/, "");
    this.pat = config.zitadelCloudPat;
    this.orgId = config.zitadelCloudOrgId;
    this.logger = logger;
  }

  private async api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.issuer}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.logger.info(`zitadel ${method} ${url.pathname}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.pat}`,
            "Content-Type": "application/json",
            ...(this.orgId ? { "x-zitadel-orgid": this.orgId } : {})
          },
          body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts) {
          break;
        }
        await Bun.sleep(attempt * 2000);
        continue;
      }

      if (!response.ok) {
        const responseText = await response.text();
        if (response.status === 404 && responseText.includes("AUTHZ-cdgFk")) {
          const orgHint = this.orgId
            ? `The configured PAT does not have membership in org ${this.orgId}.`
            : "No ZITADEL_CLOUD_ORG_ID is configured, and the PAT does not have a default org membership for management APIs.";
          throw new Error(`${orgHint} Use a PAT for a user/service account that is a member of the target org with management API rights.`);
        }
        if (attempt < this.maxAttempts && isRetryableZitadelStatus(response.status)) {
          await Bun.sleep(attempt * 2000);
          continue;
        }
        throw new Error(`ZITADEL ${method} ${url.pathname} failed with HTTP ${response.status}: ${responseText}`);
      }
      if (response.status === 204) {
        return {} as T;
      }
      return (await response.json()) as T;
    }
    throw new Error(`ZITADEL ${method} ${url.pathname} failed after retries: ${String(lastError)}`);
  }

  private async deleteResource(path: string): Promise<void> {
    const url = new URL(`${this.issuer}${path}`);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.logger.info(`zitadel DELETE ${url.pathname}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${this.pat}`,
            ...(this.orgId ? { "x-zitadel-orgid": this.orgId } : {})
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs)
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts) {
          break;
        }
        await Bun.sleep(attempt * 2000);
        continue;
      }

      if (response.ok || response.status === 404) {
        return;
      }
      if (attempt < this.maxAttempts && isRetryableZitadelStatus(response.status)) {
        await Bun.sleep(attempt * 2000);
        continue;
      }
      throw new Error(`ZITADEL DELETE ${url.pathname} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    throw new Error(`ZITADEL DELETE ${url.pathname} failed after retries: ${String(lastError)}`);
  }

  async verifyManagementAccess(): Promise<void> {
    await this.api("POST", "/management/v1/projects/_search", {});
  }

  async cleanupStaleIntegrationFixtures(): Promise<void> {
    const users = await this.api<SearchUserResult>("POST", "/management/v1/users/_search", {});
    for (const user of users.result ?? []) {
      const userId = user.userId ?? user.id ?? user.human?.userId ?? "";
      const email = user.human?.email?.email ?? user.human?.profile?.email ?? user.preferredLoginName ?? user.userName ?? user.human?.preferredLoginName ?? user.human?.userName ?? "";
      if (userId && INTEGRATION_USER_EMAIL_PATTERN.test(email)) {
        await this.deleteUser(userId);
      }
    }

    const projects = await this.api<SearchProjectResult>("POST", "/management/v1/projects/_search", {});
    for (const project of projects.result ?? []) {
      if (project.id && project.name && INTEGRATION_PROJECT_NAME_PATTERN.test(project.name)) {
        await this.deleteProject(project.id);
      }
    }
  }

  private async createProject(name: string): Promise<string> {
    const result = await this.api<ProjectResponse>("POST", "/management/v1/projects", {
      name,
      projectRoleAssertion: true,
      projectRoleCheck: true
    });
    if (!result.id) {
      throw new Error("failed to create ZITADEL project");
    }
    return result.id;
  }

  private async createRole(projectId: string, roleKey: string, displayName: string): Promise<void> {
    await this.api("POST", `/management/v1/projects/${projectId}/roles`, {
      roleKey,
      displayName,
      group: "Terrarium"
    });
  }

  private async createHumanUser(email: string, password: string): Promise<string> {
    const result = await this.api<UserResponse>("POST", "/management/v1/users/human/_import", {
      userName: email,
      profile: {
        firstName: "Terrarium",
        lastName: "Integration",
        displayName: email,
        preferredLanguage: "en",
        gender: "GENDER_UNSPECIFIED"
      },
      email: {
        email,
        isEmailVerified: true
      },
      password
    });
    if (!result.userId) {
      throw new Error(`failed to create ZITADEL user for ${email}`);
    }
    return result.userId;
  }

  private async grantRoles(userId: string, projectId: string, roleKeys: string[]): Promise<void> {
    if (roleKeys.length === 0) {
      return;
    }
    await this.api("POST", `/management/v1/users/${userId}/grants`, {
      projectId,
      roleKeys
    });
  }

  private async createOidcApp(
    projectId: string,
    name: string,
    options: {
      redirectUris: string[];
      appType: "OIDC_APP_TYPE_WEB" | "OIDC_APP_TYPE_NATIVE" | "OIDC_APP_TYPE_USER_AGENT";
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC" | "OIDC_AUTH_METHOD_TYPE_NONE";
      grantTypes: string[];
      postLogoutRedirectUris: string[];
      requireSecret: boolean;
    },
    onCreated?: (app: { appId: string; clientId: string }) => void | Promise<void>
  ): Promise<{ appId: string; clientId: string; clientSecret: string }> {
    const result = await this.api<AppResponse>("POST", `/management/v1/projects/${projectId}/apps/oidc`, {
      name,
      redirectUris: options.redirectUris,
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: options.grantTypes,
      appType: options.appType,
      authMethodType: options.authMethodType,
      postLogoutRedirectUris: options.postLogoutRedirectUris,
      version: "OIDC_VERSION_1_0",
      devMode: false,
      accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
      accessTokenRoleAssertion: true,
      idTokenRoleAssertion: true,
      idTokenUserinfoAssertion: true
    });
    if (!result.appId || !result.clientId) {
      throw new Error("failed to create ZITADEL OIDC application");
    }
    await onCreated?.({ appId: result.appId, clientId: result.clientId });

    let clientSecret = result.clientSecret ?? "";
    if (options.requireSecret && !clientSecret) {
      const secret = await this.api<{ clientSecret?: string }>("PUT", `/management/v1/projects/${projectId}/apps/${result.appId}/oidc_client_secret`);
      clientSecret = secret.clientSecret ?? "";
    }
    if (options.requireSecret && !clientSecret) {
      throw new Error("failed to obtain ZITADEL client secret");
    }
    if (options.requireSecret) {
      await this.waitForOidcClientReady(result.clientId, clientSecret, options.redirectUris[0]);
    } else {
      await this.waitForOidcAuthorizationReady(result.clientId, options.redirectUris[0]);
    }
    return {
      appId: result.appId,
      clientId: result.clientId,
      clientSecret
    };
  }

  private async waitForOidcAuthorizationReady(clientId: string, redirectUri: string): Promise<void> {
    const authorizationEndpoint = await this.discoverAuthorizationEndpoint();
    let lastError = "";
    for (let attempt = 1; attempt <= this.oidcClientReadyAttempts; attempt += 1) {
      const probe = await this.probeOidcAuthorization(authorizationEndpoint, clientId, redirectUri).catch((error) => ({
        ready: false,
        message: error instanceof Error ? error.message : String(error)
      }));
      if (probe.ready) {
        this.logger.info(`ZITADEL OIDC client ${clientId} accepts authorization requests`);
        return;
      }
      lastError = probe.message;
      this.logger.info(`waiting for ZITADEL OIDC client ${clientId} authorization setup: ${lastError}`);
      if (attempt < this.oidcClientReadyAttempts) {
        await Bun.sleep(5000);
      }
    }
    throw new Error(`ZITADEL OIDC client ${clientId} did not become authorization-ready: ${lastError}`);
  }

  private async waitForOidcClientReady(clientId: string, clientSecret: string, redirectUri: string): Promise<void> {
    const tokenEndpoint = await this.discoverTokenEndpoint();
    let lastError = "";
    for (let attempt = 1; attempt <= this.oidcClientReadyAttempts; attempt += 1) {
      const probe = await this.probeOidcClient(tokenEndpoint, clientId, clientSecret, redirectUri).catch((error) => ({
        ready: false,
        message: error instanceof Error ? error.message : String(error)
      }));
      if (probe.ready) {
        this.logger.info(`ZITADEL OIDC client ${clientId} is visible to the token endpoint`);
        return;
      }
      lastError = probe.message;
      this.logger.info(`waiting for ZITADEL OIDC client ${clientId} to become usable: ${lastError}`);
      if (attempt < this.oidcClientReadyAttempts) {
        await Bun.sleep(5000);
      }
    }
    throw new Error(`ZITADEL OIDC client ${clientId} did not become usable: ${lastError}`);
  }

  private async discoverTokenEndpoint(): Promise<string> {
    const response = await fetch(`${this.issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`ZITADEL discovery failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const discovery = (await response.json()) as { token_endpoint?: unknown };
    const tokenEndpoint = String(discovery.token_endpoint || "");
    if (!tokenEndpoint) {
      throw new Error("ZITADEL discovery document is missing token_endpoint");
    }
    return tokenEndpoint;
  }

  private async discoverAuthorizationEndpoint(): Promise<string> {
    const response = await fetch(`${this.issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`ZITADEL discovery failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const discovery = (await response.json()) as { authorization_endpoint?: unknown };
    const authorizationEndpoint = String(discovery.authorization_endpoint || "");
    if (!authorizationEndpoint) {
      throw new Error("ZITADEL discovery document is missing authorization_endpoint");
    }
    return authorizationEndpoint;
  }

  private async probeOidcClient(
    tokenEndpoint: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string
  ): Promise<{ ready: boolean; message: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: `terrarium-verification-${randomBytes(8).toString("hex")}`,
      redirect_uri: redirectUri,
      code_verifier: randomBytes(16).toString("hex")
    });
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString(),
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (response.ok) {
      return { ready: true, message: "token probe succeeded" };
    }

    const errorCode = String(parsed.error || "").trim();
    const errorDescription = String(parsed.error_description || "").trim();
    if (errorCode === "invalid_grant" || [errorCode, errorDescription].some((value) => value.includes("Errors.User.Code.Invalid"))) {
      return { ready: true, message: errorDescription || errorCode };
    }

    const message = errorDescription || errorCode || raw || `HTTP ${response.status}`;
    return { ready: false, message };
  }

  private async probeOidcAuthorization(
    authorizationEndpoint: string,
    clientId: string,
    redirectUri: string
  ): Promise<{ ready: boolean; message: string }> {
    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid email profile offline_access");
    authUrl.searchParams.set("state", randomBytes(8).toString("hex"));
    authUrl.searchParams.set("nonce", randomBytes(8).toString("hex"));
    authUrl.searchParams.set("code_challenge", randomBytes(32).toString("base64url"));
    authUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    const location = response.headers.get("location") ?? "";
    const body = await response.text().catch(() => "");
    if (response.status < 400 && !location.includes("error=")) {
      return { ready: true, message: "authorization probe accepted" };
    }
    const retryable =
      response.status >= 500 ||
      (response.status === 400 && (body.includes("Errors.App.NotFound") || body.includes("Errors.Internal") || body.includes("Errors.ResourceOwner")));
    return {
      ready: false,
      message: retryable ? body || `HTTP ${response.status}` : location || body || `HTTP ${response.status}`
    };
  }

  private async ensureGroupsAction(): Promise<void> {
    const actions = await this.api<ActionResult>("POST", "/management/v1/actions/_search", {});
    const existing = (actions.result ?? []).find((action) => action.name === GROUPS_ACTION_NAME);
    let actionId = existing?.id ?? "";
    if (!actionId) {
      const created = await this.api<{ id?: string }>("POST", "/management/v1/actions", {
        name: GROUPS_ACTION_NAME,
        script: GROUPS_ACTION_SCRIPT,
        timeout: "10s",
        allowedToFail: false
      });
      actionId = created.id ?? "";
    } else if ((existing?.script ?? "").trim() !== GROUPS_ACTION_SCRIPT.trim()) {
      await this.api("PUT", `/management/v1/actions/${actionId}`, {
        name: GROUPS_ACTION_NAME,
        script: GROUPS_ACTION_SCRIPT,
        timeout: "10s",
        allowedToFail: false
      });
    }
    if (!actionId) {
      throw new Error("failed to provision ZITADEL groups action");
    }

    for (const triggerType of ["4", "5"]) {
      const flow = await this.api<Flow>("GET", "/management/v1/flows/2");
      const trigger = (flow.flow?.triggerActions ?? []).find((item) => item.triggerType?.id === triggerType);
      const current = new Set((trigger?.actions ?? []).map((action) => action.id).filter(Boolean));
      if (!current.has(actionId)) {
        current.add(actionId);
        await this.api("POST", `/management/v1/flows/2/trigger/${triggerType}`, { actionIds: [...current] });
      }
    }
  }

  async provisionFixture(
    slug: string,
    domains: DomainBundle,
    adminGroup: string,
    routeCallbackUris: string[] = [],
    options: IntegrationOidcFixtureOptions = {},
    onProgress?: ZitadelFixtureProgressHandler
  ): Promise<ExternalOidcFixture> {
    await this.ensureGroupsAction();

    const projectName = `terrarium-${slug}`;
    const appName = `terrarium-${slug}-external`;
    const lxdAppName = `terrarium-${slug}-lxd`;
    const routeGroups = ["agents", "admins"];
    const projectId = await this.createProject(projectName);
    await onProgress?.({ type: "project", fixtureSlug: slug, projectId, projectName, adminGroup, routeGroups });
    await this.createRole(projectId, adminGroup, "Terrarium Management Admin");
    for (const routeGroup of routeGroups) {
      await this.createRole(projectId, routeGroup, `Route group ${routeGroup}`);
    }
    await this.createRole(projectId, DENIED_ROUTE_ROLE, "Route denied fixture user");

    const app = await this.createOidcApp(
      projectId,
      appName,
      {
        redirectUris: buildZitadelCloudManagementRedirectUris(domains, routeCallbackUris, options.extraDomains ?? []),
        appType: "OIDC_APP_TYPE_WEB",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
        postLogoutRedirectUris: [`https://${domains.manage}`],
        requireSecret: true
      },
      async (created) => {
        await onProgress?.({ type: "app", fixtureSlug: slug, projectId, appId: created.appId, appName });
      }
    );
    const lxdApp = await this.createOidcApp(
      projectId,
      lxdAppName,
      {
        redirectUris: buildZitadelCloudLxdRedirectUris(domains, options.extraDomains ?? []),
        appType: "OIDC_APP_TYPE_NATIVE",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
        grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN", "OIDC_GRANT_TYPE_DEVICE_CODE"],
        postLogoutRedirectUris: [`https://${domains.lxd}`],
        requireSecret: false
      },
      async (created) => {
        await onProgress?.({ type: "app", fixtureSlug: slug, projectId, appId: created.appId, appName: lxdAppName });
      }
    );

    const adminPassword = generateComplexPassword();
    const adminEmail = `admin+${slug}@example.net`;
    const adminRoles = [adminGroup, "admins"];
    const adminUserId = await this.createHumanUser(adminEmail, adminPassword);
    await onProgress?.({ type: "user", fixtureSlug: slug, kind: "adminUser", userId: adminUserId, email: adminEmail, roles: adminRoles });
    const adminUser: OidcTestUser = {
      email: adminEmail,
      password: adminPassword,
      userId: adminUserId,
      roles: adminRoles
    };
    const routePassword = generateComplexPassword();
    const routeEmail = `agent+${slug}@example.net`;
    const routeRoles = ["agents"];
    const routeUserId = await this.createHumanUser(routeEmail, routePassword);
    await onProgress?.({ type: "user", fixtureSlug: slug, kind: "routeUser", userId: routeUserId, email: routeEmail, roles: routeRoles });
    const routeUser: OidcTestUser = {
      email: routeEmail,
      password: routePassword,
      userId: routeUserId,
      roles: routeRoles
    };
    const deniedPassword = generateComplexPassword();
    const deniedEmail = `denied+${slug}@example.net`;
    const deniedRoles = [DENIED_ROUTE_ROLE];
    const deniedUserId = await this.createHumanUser(deniedEmail, deniedPassword);
    await onProgress?.({ type: "user", fixtureSlug: slug, kind: "deniedUser", userId: deniedUserId, email: deniedEmail, roles: deniedRoles });
    const deniedUser: OidcTestUser = {
      email: deniedEmail,
      password: deniedPassword,
      userId: deniedUserId,
      roles: deniedRoles
    };

    await this.grantRoles(adminUser.userId, projectId, adminUser.roles);
    await this.grantRoles(routeUser.userId, projectId, routeUser.roles);
    await this.grantRoles(deniedUser.userId, projectId, deniedUser.roles);

    return {
      projectId,
      projectName,
      appId: app.appId,
      appName,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      lxdAppId: lxdApp.appId,
      lxdAppName,
      lxdClientId: lxdApp.clientId,
      lxdClientSecret: lxdApp.clientSecret,
      adminGroup,
      routeGroups,
      adminUser,
      routeUser,
      deniedUser
    };
  }

  async cleanupFixture(fixture: ExternalOidcFixture): Promise<void> {
    for (const user of [fixture.adminUser, fixture.routeUser, fixture.deniedUser]) {
      await this.deleteUser(user.userId);
    }
    await this.deleteProject(fixture.projectId);
  }

  async deleteFixtureResource(step: ExternalOidcCleanupStep): Promise<void> {
    if (step.idpProvider !== this.provider) {
      throw new Error(`ZITADEL cleanup received ${step.idpProvider} cleanup step`);
    }
    if (step.resourceType === "role" || step.resourceType === "api-resource" || step.resourceType === "container") {
      throw new Error(`ZITADEL cleanup for ${step.resourceType} resources is not supported`);
    }
    if (step.resourceType === "user") {
      await this.deleteUser(step.resource.userId);
      return;
    }
    if (step.resourceType === "app") {
      const projectId = step.projectId ?? step.resource.projectId;
      if (!projectId) {
        throw new Error("ZITADEL app cleanup requires a project id");
      }
      await this.deleteApp(projectId, step.appId);
      return;
    }
    await this.deleteProject(step.projectId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.deleteResource(`/management/v1/users/${userId}`);
  }

  async deleteApp(projectId: string, appId: string): Promise<void> {
    await this.deleteResource(`/management/v1/projects/${projectId}/apps/${appId}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.deleteResource(`/management/v1/projects/${projectId}`);
  }

  async lookupProject(projectName: string): Promise<string> {
    const projects = await this.api<SearchProjectResult>("POST", "/management/v1/projects/_search", {});
    const match = (projects.result ?? []).find((project) => project.name === projectName);
    if (!match?.id) {
      throw new Error(`failed to find project ${projectName}`);
    }
    return match.id;
  }

  async lookupApp(projectId: string, appName: string): Promise<string> {
    const apps = await this.api<SearchAppResult>("POST", `/management/v1/projects/${projectId}/apps/_search`, {});
    const match = (apps.result ?? []).find((app) => app.name === appName);
    if (!match?.id) {
      throw new Error(`failed to find application ${appName}`);
    }
    return match.id;
  }
}
