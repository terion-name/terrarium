import { describe, expect, test } from "bun:test";
import {
  buildLocalIdpOutputs,
  isZitadelAlreadyExistsError,
  isRetriableZitadelApiError,
  isZitadelNoChangesResponse,
  mergedRoleKeys,
  parseZitadelHttpOutput
} from "../scripts/terrarium-zitadel-sync";

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
});
