import { randomUUID } from "node:crypto";
import type { DomainBundle, ExternalOidcFixture, IntegrationConfig, OidcTestUser } from "../types";
import { IntegrationLogger } from "../lib/logger";

type ProjectResponse = { id?: string };
type UserResponse = { userId?: string };
type AppResponse = { appId?: string; clientId?: string; clientSecret?: string };
type SearchProjectResult = { result?: Array<{ id?: string; name?: string }> };
type SearchAppResult = { result?: Array<{ id?: string; name?: string }> };
type ActionResult = { result?: Array<{ id?: string; name?: string; script?: string }> };
type Flow = { flow?: { triggerActions?: Array<{ triggerType?: { id?: string }; actions?: Array<{ id?: string }> }> } };

const GROUPS_ACTION_NAME = "terrariumGroups";
const GROUPS_ACTION_SCRIPT = `function terrariumGroups(ctx, api) {
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

/**
 * Creates per-run ZITADEL Cloud fixtures for Terrarium external OIDC tests.
 *
 * The fixture matches Terrarium’s current expectation of a flat `groups` claim
 * so the same admin and route-authorization checks work against cloud and local
 * ZITADEL setups.
 */
export class ZitadelCloudProvider {
  private readonly issuer: string;
  private readonly pat: string;
  private readonly logger: IntegrationLogger;

  constructor(config: IntegrationConfig, logger: IntegrationLogger) {
    this.issuer = config.zitadelCloudIssuer.replace(/\/$/, "");
    this.pat = config.zitadelCloudPat;
    this.logger = logger;
  }

  private async api<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.issuer}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    this.logger.info(`zitadel ${method} ${url.pathname}`);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.pat}`,
        "Content-Type": "application/json"
      },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`ZITADEL ${method} ${url.pathname} failed with HTTP ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
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

  private async createOidcApp(projectId: string, name: string, domains: DomainBundle): Promise<{ appId: string; clientId: string; clientSecret: string }> {
    const result = await this.api<AppResponse>("POST", `/management/v1/projects/${projectId}/apps/oidc`, {
      name,
      redirectUris: [
        `https://${domains.manage}/oauth2/callback`,
        `https://${domains.manage}/oauth2/app/callback`,
        `https://${domains.lxd}/oidc/callback`
      ],
      responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
      grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE", "OIDC_GRANT_TYPE_REFRESH_TOKEN"],
      appType: "OIDC_APP_TYPE_WEB",
      authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
      postLogoutRedirectUris: [`https://${domains.manage}`],
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

    let clientSecret = result.clientSecret ?? "";
    if (!clientSecret) {
      const secret = await this.api<{ clientSecret?: string }>("PUT", `/management/v1/projects/${projectId}/apps/${result.appId}/oidc_client_secret`);
      clientSecret = secret.clientSecret ?? "";
    }
    if (!clientSecret) {
      throw new Error("failed to obtain ZITADEL client secret");
    }
    return {
      appId: result.appId,
      clientId: result.clientId,
      clientSecret
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

  async provisionFixture(slug: string, domains: DomainBundle, adminGroup: string): Promise<ExternalOidcFixture> {
    await this.ensureGroupsAction();

    const projectName = `terrarium-${slug}`;
    const appName = `terrarium-${slug}-external`;
    const projectId = await this.createProject(projectName);
    const routeGroups = ["agents", "admins"];
    await this.createRole(projectId, adminGroup, "Terrarium Management Admin");
    for (const routeGroup of routeGroups) {
      await this.createRole(projectId, routeGroup, `Route group ${routeGroup}`);
    }

    const app = await this.createOidcApp(projectId, appName, domains);

    const adminPassword = randomUUID();
    const adminUser: OidcTestUser = {
      email: `admin+${slug}@example.net`,
      password: adminPassword,
      userId: await this.createHumanUser(`admin+${slug}@example.net`, adminPassword),
      roles: [adminGroup, "admins"]
    };
    const routePassword = randomUUID();
    const routeUser: OidcTestUser = {
      email: `agent+${slug}@example.net`,
      password: routePassword,
      userId: await this.createHumanUser(`agent+${slug}@example.net`, routePassword),
      roles: ["agents"]
    };
    const deniedPassword = randomUUID();
    const deniedUser: OidcTestUser = {
      email: `denied+${slug}@example.net`,
      password: deniedPassword,
      userId: await this.createHumanUser(`denied+${slug}@example.net`, deniedPassword),
      roles: []
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
      adminGroup,
      routeGroups,
      adminUser,
      routeUser,
      deniedUser
    };
  }

  async cleanupFixture(fixture: ExternalOidcFixture): Promise<void> {
    for (const user of [fixture.adminUser, fixture.routeUser, fixture.deniedUser]) {
      await fetch(`${this.issuer}/management/v1/users/${user.userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.pat}` }
      });
    }
    await fetch(`${this.issuer}/management/v1/projects/${fixture.projectId}/apps/${fixture.appId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.pat}` }
    });
    await fetch(`${this.issuer}/management/v1/projects/${fixture.projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.pat}` }
    });
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
