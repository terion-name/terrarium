import { describe, expect, test } from "bun:test";
import {
  buildLocalIdpOutputs,
  isZitadelAlreadyExistsError,
  isRetriableZitadelApiError,
  isZitadelNoChangesResponse,
  localOidcAppSpecs,
  lookupUserId,
  mergedRoleKeys,
  parseZitadelHttpOutput
} from "../scripts/terrarium-zitadel-sync";

type LookupCall = {
  authDomain: string;
  pat: string;
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
};

describe("terrarium local ZITADEL sync", () => {
  test("writes the stable outputs contract consumed by oauth2-proxy, LXD, and route auth", () => {
    const output = JSON.parse(
      buildLocalIdpOutputs(
        "project-1",
        {
          cockpit: { appId: "app-cockpit", clientId: "cockpit-client", clientSecret: "cockpit-secret" },
          lxd: { appId: "app-lxd", clientId: "lxd-client" },
          routes: { appId: "app-routes", clientId: "routes-client", clientSecret: "routes-secret" }
        },
        "auth.example.test"
      )
    );

    expect(output).toMatchObject({
      cockpit_client_id: { sensitive: true, type: "string", value: "cockpit-client" },
      cockpit_client_secret: { sensitive: true, type: "string", value: "cockpit-secret" },
      issuer: { sensitive: false, type: "string", value: "https://auth.example.test/" },
      lxd_client_id: { sensitive: true, type: "string", value: "lxd-client" },
      project_id: { sensitive: false, type: "string", value: "project-1" },
      routes_client_id: { sensitive: true, type: "string", value: "routes-client" },
      routes_client_secret: { sensitive: true, type: "string", value: "routes-secret" }
    });
  });

  test("parses ZITADEL API bodies separately from curl's status trailer", () => {
    expect(parseZitadelHttpOutput('{"ok":true}\n__terrarium_http_status__:200')).toEqual({
      status: 200,
      body: '{"ok":true}'
    });
  });

  test("treats ZITADEL no-op updates as idempotent success responses", () => {
    expect(isZitadelNoChangesResponse(400, '{"code":9,"message":"No changes"}')).toBe(true);
    expect(isZitadelNoChangesResponse(400, '{"code":3,"message":"bad request"}')).toBe(false);
  });

  test("retries role grant races after creating local project roles", () => {
    expect(isRetriableZitadelApiError('ZITADEL API POST /management/v1/users/123/grants returned HTTP 400: {"message":"Errors.Project.Role.NotFound"}')).toBe(
      true
    );
  });

  test("accepts role create already-exists responses during reconciliation", () => {
    expect(isZitadelAlreadyExistsError('ZITADEL API POST /management/v1/projects/p1/roles returned HTTP 400: {"message":"Errors.Already.Exists"}')).toBe(
      true
    );
    expect(isZitadelAlreadyExistsError('ZITADEL API POST /management/v1/projects/p1/roles returned HTTP 400: {"message":"Errors.Invalid.Argument"}')).toBe(
      false
    );
  });

  test("preserves existing grant roles when adding the local admin group", () => {
    expect(mergedRoleKeys(["auditor", "operators"], "terrarium-admins")).toEqual(["auditor", "operators", "terrarium-admins"]);
    expect(mergedRoleKeys(["terrarium-admins"], "terrarium-admins")).toEqual(["terrarium-admins"]);
  });

  test("registers local management callbacks for each host-only oauth2-proxy cookie origin", () => {
    const apps = localOidcAppSpecs(
      {
        terrarium_manage_domain: "manage.example.test",
        terrarium_proxy_domain: "proxy.example.test",
        terrarium_lxd_domain: "lxd.example.test"
      },
      "auth.example.test"
    );
    const cockpit = apps.find((app) => app.outputPrefix === "cockpit");

    expect(cockpit?.redirectUris).toEqual(["https://manage.example.test/oauth2/callback", "https://proxy.example.test/oauth2/callback"]);
    expect(cockpit?.postLogoutRedirectUris).toEqual(["https://manage.example.test/", "https://proxy.example.test/"]);
  });

  test("looks up the local admin by exact ZITADEL login name", async () => {
    const calls: LookupCall[] = [];
    const userId = await lookupUserId("auth.example.test", "pat-1", "configured-admin@example.com", async <T>(
      authDomain: string,
      pat: string,
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      query?: Record<string, string>
    ): Promise<T> => {
      calls.push({ authDomain, pat, method, path, body, query });
      return { user: { id: "admin-user" } } as T;
    });

    expect(userId).toBe("admin-user");
    expect(calls).toEqual([
      {
        authDomain: "auth.example.test",
        pat: "pat-1",
        method: "GET",
        path: "/management/v1/global/users/_by_login_name",
        body: undefined,
        query: { loginName: "configured-admin@example.com" }
      }
    ]);
  });

  test("does not fall back to an unrelated singleton human user", async () => {
    const calls: LookupCall[] = [];
    await expect(
      lookupUserId("auth.example.test", "pat-1", "stale-admin@example.com", async <T>(
        authDomain: string,
        pat: string,
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
        query?: Record<string, string>
      ): Promise<T> => {
        calls.push({ authDomain, pat, method, path, body, query });
        return {
          result: [{ userId: "attacker-singleton", human: { email: { email: "attacker@example.com" } } }]
        } as T;
      })
    ).rejects.toThrow(
      "failed to find ZITADEL user for login name stale-admin@example.com"
    );

    expect(calls).toEqual([
      {
        authDomain: "auth.example.test",
        pat: "pat-1",
        method: "GET",
        path: "/management/v1/global/users/_by_login_name",
        body: undefined,
        query: { loginName: "stale-admin@example.com" }
      }
    ]);
  });
});
