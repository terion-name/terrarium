import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationLogger } from "../lib/logger";
import type { ExternalOidcFixture, IntegrationConfig } from "../types";
import { ZitadelCloudProvider } from "./zitadel-cloud";

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
};

const logger = {
  path: "",
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  }
} as unknown as IntegrationLogger;

function createProvider(): ZitadelCloudProvider {
  return new ZitadelCloudProvider(
    {
      zitadelCloudIssuer: "https://zitadel.example.test/",
      zitadelCloudPat: "pat-1",
      zitadelCloudOrgId: "org-1"
    } as IntegrationConfig,
    logger
  );
}

function setMaxAttempts(provider: ZitadelCloudProvider, maxAttempts: number): void {
  (provider as unknown as { maxAttempts: number }).maxAttempts = maxAttempts;
}

function setOidcClientReadyAttempts(provider: ZitadelCloudProvider, attempts: number): void {
  (provider as unknown as { oidcClientReadyAttempts: number }).oidcClientReadyAttempts = attempts;
}

function setSleepMock(handler: (ms: number) => Promise<void>): void {
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = handler as typeof Bun.sleep;
}

function installFetchMock(respond: (call: FetchCall, index: number) => Response): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const call = { input, init };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function callPath(call: FetchCall): string {
  return new URL(String(call.input)).pathname;
}

function expectScopedZitadelDelete(call: FetchCall): void {
  const headers = new Headers(call.init?.headers);
  expect(call.init?.method).toBe("DELETE");
  expect(headers.get("authorization")).toBe("Bearer pat-1");
  expect(headers.get("x-zitadel-orgid")).toBe("org-1");
}

function jsonBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? "{}")) as Record<string, unknown>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = originalSleep;
});

describe("ZITADEL Cloud provider", () => {
  test("cleanupFixture uses scoped delete helpers for users and project", async () => {
    const calls = installFetchMock(() => new Response(null, { status: 204 }));
    const provider = createProvider();
    const fixture = {
      projectId: "project-1",
      appId: "app-1",
      adminUser: { userId: "admin-user" },
      routeUser: { userId: "route-user" },
      deniedUser: { userId: "denied-user" }
    } as ExternalOidcFixture;

    await provider.cleanupFixture(fixture);

    expect(calls.map(callPath)).toEqual([
      "/management/v1/users/admin-user",
      "/management/v1/users/route-user",
      "/management/v1/users/denied-user",
      "/management/v1/projects/project-1"
    ]);
    for (const call of calls) {
      expectScopedZitadelDelete(call);
    }
  });

  test("delete helpers retry transient ZITADEL responses with the org header", async () => {
    const calls = installFetchMock((_call, index) => (index === 0 ? new Response("busy", { status: 429 }) : new Response(null, { status: 204 })));
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const provider = createProvider();
    setMaxAttempts(provider, 2);

    await provider.deleteProject("project-1");

    expect(calls.map(callPath)).toEqual(["/management/v1/projects/project-1", "/management/v1/projects/project-1"]);
    expect(sleeps).toEqual([2000]);
    for (const call of calls) {
      expectScopedZitadelDelete(call);
    }
  });

  test("management preflight fails permission errors without retrying", async () => {
    const calls = installFetchMock(() => new Response("AUTHZ-cdgFk", { status: 404 }));
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const provider = createProvider();
    setMaxAttempts(provider, 3);

    await expect(provider.verifyManagementAccess()).rejects.toThrow("PAT does not have membership in org org-1");

    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    const headers = new Headers(calls[0].init?.headers);
    expect(calls[0].init?.method).toBe("POST");
    expect(callPath(calls[0])).toBe("/management/v1/projects/_search");
    expect(headers.get("authorization")).toBe("Bearer pat-1");
    expect(headers.get("x-zitadel-orgid")).toBe("org-1");
  });

  test("provisionFixture grants the denied user a project role outside route allowed groups", async () => {
    const userIds = ["admin-user", "route-user", "denied-user"];
    let appCount = 0;
    const calls = installFetchMock((call) => {
      const method = call.init?.method ?? "GET";
      const path = callPath(call);
      if (method === "POST" && path === "/management/v1/actions/_search") {
        return Response.json({ result: [] });
      }
      if (method === "POST" && path === "/management/v1/actions") {
        return Response.json({ id: "action-1" });
      }
      if (method === "GET" && path === "/management/v1/flows/2") {
        return Response.json({ flow: { triggerActions: [] } });
      }
      if (method === "POST" && path.startsWith("/management/v1/flows/2/trigger/")) {
        return Response.json({});
      }
      if (method === "POST" && path === "/management/v1/projects") {
        return Response.json({ id: "project-1" });
      }
      if (method === "POST" && path === "/management/v1/projects/project-1/roles") {
        return Response.json({});
      }
      if (method === "POST" && path === "/management/v1/projects/project-1/apps/oidc") {
        appCount += 1;
        return appCount === 1
          ? Response.json({ appId: "app-1", clientId: "client-1", clientSecret: "secret-1" })
          : Response.json({ appId: "lxd-app-1", clientId: "lxd-client-1" });
      }
      if (method === "GET" && path === "/.well-known/openid-configuration") {
        return Response.json({
          authorization_endpoint: "https://zitadel.example.test/oauth/v2/authorize",
          token_endpoint: "https://zitadel.example.test/oauth/v2/token"
        });
      }
      if (method === "POST" && path === "/oauth/v2/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (method === "GET" && path === "/oauth/v2/authorize") {
        return new Response("", {
          status: 302,
          headers: { location: "https://zitadel.example.test/ui/login" }
        });
      }
      if (method === "POST" && path === "/management/v1/users/human/_import") {
        return Response.json({ userId: userIds.shift() });
      }
      if (method === "POST" && path.startsWith("/management/v1/users/") && path.endsWith("/grants")) {
        return Response.json({});
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = createProvider();

    const fixture = await provider.provisionFixture(
      "run-d",
      {
        manage: "manage.example.test",
        proxy: "proxy.example.test",
        lxd: "lxd.example.test",
        auth: "auth.example.test"
      },
      "terrarium-admins"
    );

    const roleKeys = calls
      .filter((call) => call.init?.method === "POST" && callPath(call) === "/management/v1/projects/project-1/roles")
      .map((call) => jsonBody(call).roleKey);
    const grants = calls
      .filter((call) => call.init?.method === "POST" && callPath(call).endsWith("/grants"))
      .map((call) => jsonBody(call));

    expect(fixture.routeGroups).toEqual(["agents", "admins"]);
    expect(fixture.clientId).toBe("client-1");
    expect(fixture.clientSecret).toBe("secret-1");
    expect(fixture.lxdClientId).toBe("lxd-client-1");
    expect(fixture.lxdClientSecret).toBe("");
    expect(fixture.deniedUser.roles).toEqual(["bystanders"]);
    expect(roleKeys).toEqual(["terrarium-admins", "agents", "admins", "bystanders"]);
    expect(grants).toContainEqual({ projectId: "project-1", roleKeys: ["bystanders"] });
    const appBodies = calls
      .filter((call) => call.init?.method === "POST" && callPath(call) === "/management/v1/projects/project-1/apps/oidc")
      .map((call) => jsonBody(call));
    expect(appBodies).toMatchObject([
      {
        appType: "OIDC_APP_TYPE_WEB",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_BASIC",
        redirectUris: expect.arrayContaining([
          "https://manage.example.test/oauth2/callback",
          "https://proxy.example.test/oauth2/callback"
        ])
      },
      {
        appType: "OIDC_APP_TYPE_NATIVE",
        authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
        redirectUris: ["https://lxd.example.test/oidc/callback"]
      }
    ]);
  });

  test("can register one external OIDC fixture for multiple Terrarium node domains", async () => {
    const calls = installFetchMock((call) => {
      const method = call.init?.method ?? "GET";
      const path = callPath(call);
      if (method === "POST" && path === "/management/v1/actions/_search") {
        return Response.json({ result: [] });
      }
      if (method === "POST" && path === "/management/v1/actions") {
        return Response.json({ id: "action-1" });
      }
      if (method === "GET" && path === "/management/v1/flows/2") {
        return Response.json({ flow: { triggerActions: [] } });
      }
      if (method === "POST" && path.startsWith("/management/v1/flows/2/trigger/")) {
        return Response.json({});
      }
      if (method === "POST" && path === "/management/v1/projects") {
        return Response.json({ id: "project-1" });
      }
      if (method === "POST" && path === "/management/v1/projects/project-1/roles") {
        return Response.json({});
      }
      if (method === "POST" && path === "/management/v1/projects/project-1/apps/oidc") {
        const appName = String(jsonBody(call).name ?? "");
        return Response.json(
          appName.endsWith("-lxd")
            ? { appId: "lxd-app-1", clientId: "lxd-client-1" }
            : { appId: "app-1", clientId: "client-1", clientSecret: "secret-1" }
        );
      }
      if (method === "GET" && path === "/.well-known/openid-configuration") {
        return Response.json({
          authorization_endpoint: "https://zitadel.example.test/oauth/v2/authorize",
          token_endpoint: "https://zitadel.example.test/oauth/v2/token"
        });
      }
      if (method === "POST" && path === "/oauth/v2/token") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (method === "GET" && path === "/oauth/v2/authorize") {
        return new Response("", {
          status: 302,
          headers: { location: "https://zitadel.example.test/ui/login" }
        });
      }
      if (method === "POST" && path === "/management/v1/users/human/_import") {
        return Response.json({ userId: `user-${calls.length}` });
      }
      if (method === "POST" && path.startsWith("/management/v1/users/") && path.endsWith("/grants")) {
        return Response.json({});
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const provider = createProvider();

    await provider.provisionFixture(
      "run-e",
      {
        manage: "seed-manage.example.test",
        proxy: "seed-proxy.example.test",
        lxd: "seed-lxd.example.test",
        auth: "seed-auth.example.test"
      },
      "terrarium-admins",
      [],
      {
        extraDomains: [
          {
            manage: "join-manage.example.test",
            proxy: "join-proxy.example.test",
            lxd: "join-lxd.example.test",
            auth: "join-auth.example.test"
          }
        ]
      }
    );

    const appBodies = calls
      .filter((call) => call.init?.method === "POST" && callPath(call) === "/management/v1/projects/project-1/apps/oidc")
      .map((call) => jsonBody(call));
    expect(appBodies[0].redirectUris).toEqual(
      expect.arrayContaining([
        "https://seed-manage.example.test/oauth2/callback",
        "https://seed-proxy.example.test/oauth2/callback",
        "https://join-manage.example.test/oauth2/callback",
        "https://join-proxy.example.test/oauth2/callback"
      ])
    );
    expect(appBodies[1].redirectUris).toEqual(
      expect.arrayContaining(["https://seed-lxd.example.test/oidc/callback", "https://join-lxd.example.test/oidc/callback"])
    );
  });

  test("waits for newly-created OIDC clients to reach the token endpoint", async () => {
    const calls = installFetchMock((call, index) => {
      const method = call.init?.method ?? "GET";
      const path = callPath(call);
      if (method === "GET" && path === "/.well-known/openid-configuration") {
        return Response.json({ token_endpoint: "https://zitadel.example.test/oauth/v2/token" });
      }
      if (method === "POST" && path === "/oauth/v2/token" && index === 1) {
        return Response.json({ error: "invalid_client", error_description: "client not found" }, { status: 401 });
      }
      if (method === "POST" && path === "/oauth/v2/token") {
        return Response.json({ error: "Errors.User.Code.Invalid" }, { status: 400 });
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const provider = createProvider();
    setOidcClientReadyAttempts(provider, 2);

    await (
      provider as unknown as {
        waitForOidcClientReady(clientId: string, clientSecret: string, redirectUri: string): Promise<void>;
      }
    ).waitForOidcClientReady("client-1", "secret-1", "https://manage.example.test/oauth2/callback");

    expect(calls.map(callPath)).toEqual(["/.well-known/openid-configuration", "/oauth/v2/token", "/oauth/v2/token"]);
    expect(sleeps).toEqual([5000]);
  });
});
