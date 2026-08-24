import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLocalIdpOutputs,
  buildLogtoApplicationBody,
  buildLogtoCurlCommand,
  buildLogtoPostgresCandidateCommand,
  buildLogtoRuntime,
  buildLogtoTokenRequest,
  buildLxdOidcConfigCommands,
  ensureEmailPasswordSignInExperience,
  ensureLogtoAdminRole,
  ensureLogtoAdminUserRole,
  findTerrariumLogtoApp,
  idpSyncCmd,
  isRetriableLogtoApiError,
  localLogtoManagementApiResources,
  localLogtoManagementEndpoints,
  localLogtoOidcAppSpecs,
  matchesTerrariumLogtoApp,
  parseLogtoHttpOutput,
  parsePsqlManagementAppCandidatesOutput,
  previousLogtoClientSecret,
  redactLogtoSecrets,
  requestLogtoManagementToken,
  resolveLocalLogtoIssuer,
  selectLogtoUserByEmail,
  writeLocalLogtoOutputs,
  writeLogtoHeaderFile,
  type LogtoApiCall,
  type LogtoSyncDependencies
} from "../scripts/terrarium-logto-sync";

function stubDeps(overrides: Partial<LogtoSyncDependencies> = {}): LogtoSyncDependencies {
  return {
    loadConfig: () => ({}),
    runAllowFailure: async () => ({ exitCode: 1, stdout: "", stderr: "unexpected runAllowFailure" }),
    runText: async (cmd) => {
      throw new Error(`unexpected runText: ${cmd.join(" ")}`);
    },
    readJsonFile: <T>(_path: string, fallback: T): T => fallback,
    writeIfChanged: () => true,
    which: () => null,
    existsSync: () => false,
    sleep: async () => {},
    writeHeaderFile: writeLogtoHeaderFile,
    ...overrides
  };
}

describe("terrarium local Logto sync", () => {
  test("external IDP mode returns without invoking local runtime dependencies", async () => {
    let invoked = false;
    await expect(
      idpSyncCmd(
        "unused.yaml",
        stubDeps({
          loadConfig: () => ({ terrarium_idp_mode: "external", terrarium_idp_provider: "logto" }),
          runAllowFailure: async () => {
            invoked = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          runText: async () => {
            invoked = true;
            return "";
          }
        })
      )
    ).resolves.toBeUndefined();
    expect(invoked).toBe(false);
  });

  test("refuses local providers other than Logto before provisioning", async () => {
    await expect(
      idpSyncCmd(
        "unused.yaml",
        stubDeps({
          loadConfig: () => ({ terrarium_idp_mode: "local", terrarium_auth_domain: "auth.example.test" })
        })
      )
    ).rejects.toThrow("Logto sync cannot run for local IDP provider zitadel; expected logto");
  });

  test("uses local Logto defaults when Logto-specific config is omitted", () => {
    const runtime = buildLogtoRuntime({});
    const tokenRequest = buildLogtoTokenRequest("https://auth.example.test", "management-secret");
    const lxdCommands = buildLxdOidcConfigCommands({}, "https://auth.example.test/oidc", {
      appId: "app-lxd",
      clientId: "lxd-client"
    });

    expect(runtime).toEqual({
      instanceName: "terrarium-idp",
      logtoDir: "/var/lib/terrarium/logto",
      composeProject: "terrarium-logto",
      composeFile: "/var/lib/terrarium/logto/docker-compose.yml"
    });
    expect(tokenRequest.stdin).toContain("resource=https%3A%2F%2Fdefault.logto.app%2Fapi");
    expect(lxdCommands).toContainEqual(["/snap/bin/lxc", "config", "set", "oidc.groups.claim", "roles"]);
    expect(lxdCommands).toContainEqual(["/snap/bin/lxc", "config", "set", "oidc.scopes", "openid profile email roles"]);
  });

  test("parses Logto API bodies separately from curl's status trailer", () => {
    expect(parseLogtoHttpOutput('{"ok":true}\n__terrarium_logto_http_status__:200')).toEqual({
      status: 200,
      body: '{"ok":true}'
    });
    expect(() => parseLogtoHttpOutput('{"ok":true}')).toThrow("HTTP status marker");
    expect(() => parseLogtoHttpOutput('{"ok":true}\n__terrarium_logto_http_status__:wat')).toThrow("invalid HTTP status");
  });

  test("classifies transient Logto API failures for bounded retries", () => {
    expect(isRetriableLogtoApiError("curl: (7) Failed to connect to auth.example.test")).toBe(true);
    expect(isRetriableLogtoApiError("Logto API GET /api/applications returned HTTP 502: bad gateway")).toBe(true);
    expect(isRetriableLogtoApiError("Logto API GET /api/applications returned HTTP 503: unavailable")).toBe(true);
    expect(isRetriableLogtoApiError("Logto API GET /api/applications returned HTTP 504: timeout")).toBe(true);
    expect(isRetriableLogtoApiError("Logto API GET /api/applications returned HTTP 401: unauthorized")).toBe(false);
  });

  test("probes Logto discovery under the OIDC issuer path", () => {
    const source = Bun.file(join(import.meta.dir, "../scripts/terrarium-logto-sync.ts")).text();

    return expect(source).resolves.toContain("https://${authDomain}/oidc/.well-known/openid-configuration");
  });

  test("writes local Logto outputs with the canonical OIDC issuer", () => {
    const apps = {
      cockpit: { appId: "app-cockpit", clientId: "cockpit-client", clientSecret: "cockpit-secret" },
      lxd: { appId: "app-lxd", clientId: "lxd-client" },
      routes: { appId: "app-routes", clientId: "routes-client", clientSecret: "routes-secret" }
    };

    expect(resolveLocalLogtoIssuer("auth.example.test")).toBe("https://auth.example.test/oidc");
    expect(resolveLocalLogtoIssuer("https://auth.example.test/")).toBe("https://auth.example.test/oidc");
    expect(resolveLocalLogtoIssuer("https://auth.example.test/oidc/")).toBe("https://auth.example.test/oidc");

    const outputs = JSON.parse(buildLocalIdpOutputs("default", apps, "https://auth.example.test/"));
    expect(outputs.issuer.value).toBe("https://auth.example.test/oidc");
  });

  test("keeps token and API secrets out of curl argv", () => {
    const tokenRequest = buildLogtoTokenRequest("https://auth.example.test", "m-admin-secret");
    const tokenCmd = buildLogtoCurlCommand("auth.example.test", "POST", tokenRequest.url, "/tmp/token-headers", true, () => false);
    const apiBody = JSON.stringify({ secret: "json-body-secret" });
    const apiCmd = buildLogtoCurlCommand("auth.example.test", "PATCH", "https://auth.example.test/api/applications/app", "/tmp/api-headers", true, () => false);

    expect(tokenCmd.join(" ")).not.toContain("m-admin-secret");
    expect(tokenCmd.join(" ")).not.toContain(tokenRequest.stdin);
    expect(tokenCmd).toContain("@/tmp/token-headers");
    expect(tokenCmd).toContain("@-");
    expect(apiCmd.join(" ")).not.toContain("bearer-token");
    expect(apiCmd.join(" ")).not.toContain(apiBody);
    expect(apiCmd).toContain("@/tmp/api-headers");
    expect(apiCmd).toContain("@-");
  });

  test("writes temporary Logto header files with 0600 permissions", () => {
    const header = writeLogtoHeaderFile("Authorization: Bearer fake-token\n", "api");
    try {
      expect(statSync(header.path).mode & 0o777).toBe(0o600);
      expect(statSync(header.dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(header.dir, { recursive: true, force: true });
    }
  });

  test("redacts fake secrets, tokens, and request bodies from errors", () => {
    const message = "m-admin-secret bearer-token grant_type=client_credentials {\"clientSecret\":\"body-secret\"}";
    expect(redactLogtoSecrets(message, ["m-admin-secret", "bearer-token", "grant_type=client_credentials", '{"clientSecret":"body-secret"}'])).toBe(
      "[REDACTED] [REDACTED] [REDACTED] [REDACTED]"
    );
  });

  test("builds deterministic managed and host Postgres candidate commands", () => {
    const runtime = buildLogtoRuntime({ terrarium_logto_instance_name: "custom-logto" });
    const managed = buildLogtoPostgresCandidateCommand(runtime, true);
    const host = buildLogtoPostgresCandidateCommand(runtime, false);

    expect(managed.cmd.slice(0, 4)).toEqual(["lxc", "exec", "custom-logto", "--"]);
    expect(managed.cmd).toContain("terrarium-logto");
    expect(managed.cmd).toContain("/var/lib/terrarium/logto/docker-compose.yml");
    expect(managed.cmd).toContain("-t");
    expect(managed.cmd).toContain("-A");
    expect(managed.cmd).toContain("-q");
    const candidateSql = managed.cmd[managed.cmd.indexOf("-c") + 1] ?? "";
    expect(candidateSql).toContain("application_secrets");
    expect(candidateSql).toContain("app_secret.application_id = app.id");
    expect(candidateSql).toContain("coalesce(app_secret.value::text, '') <> ''");
    expect(candidateSql).toContain("app_secret.expires_at is null or app_secret.expires_at > now()");
    expect(candidateSql).toContain("order by app_secret.created_at desc nulls last");
    expect(candidateSql).toContain("insert into terrarium_logto_management_app_candidate_rows");
    expect(candidateSql).toContain("case when app.id = 'm-default' then 0 when app.id = 'm-admin' then 1 else 2 end");
    expect(candidateSql).not.toContain("if found then");
    expect(candidateSql).toContain("id::text as app_id");
    expect(candidateSql).toContain("secret::text as secret");
    expect(candidateSql).toContain("case when id = 'm-default' then 0 when id = 'm-admin' then 1 else 2 end");
    expect(candidateSql).toContain("select distinct on (candidate_rows.app_id, candidate_rows.secret)");
    expect(candidateSql).toContain("order by deduped.app_priority, deduped.app_id, deduped.source_priority, deduped.secret");
    expect(host.cmd.slice(0, 2)).toEqual(["docker", "compose"]);
    expect(host.cwd).toBe("/var/lib/terrarium/logto");
  });

  test("parses Logto Management API app candidates from psql output", () => {
    expect(parsePsqlManagementAppCandidatesOutput("\n m-admin|secret-1 \n seeded-m2m\tsecret-2\n m-admin|secret-1\n")).toEqual([
      { appId: "m-admin", secret: "secret-1" },
      { appId: "seeded-m2m", secret: "secret-2" }
    ]);
    expect(parsePsqlManagementAppCandidatesOutput("\n\n")).toEqual([]);
    expect(() => parsePsqlManagementAppCandidatesOutput("missing-delimiter\n")).toThrow("without both app id and secret");
  });

  test("builds Logto management token requests with Basic and form-post client auth", () => {
    const request = buildLogtoTokenRequest("https://auth.example.test/", "secret-1");
    const auth = request.headers.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";

    expect(request.authMethod).toBe("basic");
    expect(request.url).toBe("https://auth.example.test/oidc/token");
    expect(Buffer.from(auth, "base64").toString("utf8")).toBe("m-admin:secret-1");
    expect(request.stdin).toContain("grant_type=client_credentials");
    expect(request.stdin).toContain("resource=https%3A%2F%2Fdefault.logto.app%2Fapi");
    expect(request.stdin).toContain("scope=all");
    expect(request.stdin).not.toContain("client_secret");

    const postRequest = buildLogtoTokenRequest("https://auth.example.test/", "secret-1", "https://admin.logto.app/api", "m-admin", "post");
    const postBody = new URLSearchParams(postRequest.stdin);
    expect(postRequest.authMethod).toBe("post");
    expect(postRequest.headers).not.toContain("Authorization");
    expect(postBody.get("grant_type")).toBe("client_credentials");
    expect(postBody.get("client_id")).toBe("m-admin");
    expect(postBody.get("client_secret")).toBe("secret-1");
    expect(postBody.get("resource")).toBe("https://admin.logto.app/api");
    expect(postBody.get("scope")).toBe("all");
  });

  test("adds the Logto OSS admin Management API resource as a local token fallback", () => {
    expect(localLogtoManagementApiResources("https://default.logto.app/api")).toEqual([
      "https://default.logto.app/api",
      "https://admin.logto.app/api"
    ]);
    expect(localLogtoManagementApiResources(" https://admin.logto.app/api ")).toEqual(["https://admin.logto.app/api"]);
  });

  test("tries the Logto admin endpoint for local management tokens before the public API endpoint", () => {
    expect(localLogtoManagementEndpoints("auth.example.test", {})).toEqual([
      { tokenEndpoint: "http://localhost:3002", apiEndpoint: "https://auth.example.test" },
      { tokenEndpoint: "https://auth.example.test", apiEndpoint: "https://auth.example.test" }
    ]);
    expect(
      localLogtoManagementEndpoints("auth.example.test", {
        terrarium_logto_admin_port: 33012,
        terrarium_logto_admin_endpoint: " http://localhost:33012/ "
      })
    ).toEqual([
      { tokenEndpoint: "http://localhost:33012", apiEndpoint: "https://auth.example.test" },
      { tokenEndpoint: "https://auth.example.test", apiEndpoint: "https://auth.example.test" }
    ]);
  });

  test("prefers the default-tenant management client for the default Management API resource", async () => {
    const headersByPath = new Map<string, string>();
    const attemptedCredentials: string[] = [];
    let headerCount = 0;

    const token = await requestLogtoManagementToken(
      "auth.example.test",
      "http://localhost:3002",
      [
        { appId: "m-admin", secret: "admin-secret" },
        { appId: "m-default", secret: "default-secret" }
      ],
      "https://default.logto.app/api",
      stubDeps({
        writeHeaderFile: (content, label) => {
          headerCount += 1;
          const path = `/tmp/terrarium-logto-sync-test-${label}-${headerCount}`;
          headersByPath.set(path, content);
          return { dir: `/tmp/terrarium-logto-sync-test-dir-${headerCount}`, path };
        },
        runAllowFailure: async (cmd, options) => {
          const headerFlagIndex = cmd.indexOf("-H");
          const headerPathArg = headerFlagIndex >= 0 ? cmd[headerFlagIndex + 1] ?? "" : "";
          const header = headersByPath.get(headerPathArg.replace(/^@/, "")) ?? "";
          const auth = header.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";
          const credentials = auth ? Buffer.from(auth, "base64").toString("utf8") : "";
          attemptedCredentials.push(credentials);
          expect(cmd).toContain("http://localhost:3002/oidc/token");
          expect(new URLSearchParams(String(options?.stdin ?? "")).get("resource")).toBe("https://default.logto.app/api");
          return { exitCode: 0, stdout: '{"access_token":"default-management-token"}\n__terrarium_logto_http_status__:200', stderr: "" };
        }
      })
    );

    expect(token).toBe("default-management-token");
    expect(attemptedCredentials).toEqual(["m-default:default-secret"]);
  });

  test("uses legacy m-default discovered alongside generated application_secrets candidates", async () => {
    const candidates = parsePsqlManagementAppCandidatesOutput(
      "m-default|legacy-default-secret\n" +
        "m-admin|legacy-admin-secret\n" +
        "9idgenerated|generated-secret\n" +
        "m-default|legacy-default-secret\n"
    );
    const headersByPath = new Map<string, string>();
    const attemptedCredentials: string[] = [];
    let headerCount = 0;

    expect(candidates).toEqual([
      { appId: "m-default", secret: "legacy-default-secret" },
      { appId: "m-admin", secret: "legacy-admin-secret" },
      { appId: "9idgenerated", secret: "generated-secret" }
    ]);

    const token = await requestLogtoManagementToken(
      "auth.example.test",
      "http://localhost:3002",
      candidates,
      "https://default.logto.app/api",
      stubDeps({
        writeHeaderFile: (content, label) => {
          headerCount += 1;
          const path = `/tmp/terrarium-logto-sync-test-${label}-${headerCount}`;
          headersByPath.set(path, content);
          return { dir: `/tmp/terrarium-logto-sync-test-dir-${headerCount}`, path };
        },
        runAllowFailure: async (cmd, options) => {
          const headerFlagIndex = cmd.indexOf("-H");
          const headerPathArg = headerFlagIndex >= 0 ? cmd[headerFlagIndex + 1] ?? "" : "";
          const header = headersByPath.get(headerPathArg.replace(/^@/, "")) ?? "";
          const auth = header.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";
          const credentials = auth ? Buffer.from(auth, "base64").toString("utf8") : "";
          attemptedCredentials.push(credentials);
          expect(new URLSearchParams(String(options?.stdin ?? "")).get("resource")).toBe("https://default.logto.app/api");
          return { exitCode: 0, stdout: '{"access_token":"legacy-default-token"}\n__terrarium_logto_http_status__:200', stderr: "" };
        }
      })
    );

    expect(token).toBe("legacy-default-token");
    expect(attemptedCredentials).toEqual(["m-default:legacy-default-secret"]);
  });

  test("falls back to form-post client auth when Basic auth is invalid for m-admin", async () => {
    const headersByPath = new Map<string, string>();
    const attemptedAuthMethods: string[] = [];
    let headerCount = 0;

    const token = await requestLogtoManagementToken(
      "auth.example.test",
      "https://auth.example.test",
      [{ appId: "m-admin", secret: "good-secret" }],
      "https://admin.logto.app/api",
      stubDeps({
        writeHeaderFile: (content, label) => {
          headerCount += 1;
          const path = `/tmp/terrarium-logto-sync-test-${label}-${headerCount}`;
          headersByPath.set(path, content);
          return { dir: `/tmp/terrarium-logto-sync-test-dir-${headerCount}`, path };
        },
        runAllowFailure: async (cmd, options) => {
          const headerFlagIndex = cmd.indexOf("-H");
          const headerPathArg = headerFlagIndex >= 0 ? cmd[headerFlagIndex + 1] ?? "" : "";
          const header = headersByPath.get(headerPathArg.replace(/^@/, "")) ?? "";
          const auth = header.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";
          if (auth) {
            attemptedAuthMethods.push("basic");
            expect(Buffer.from(auth, "base64").toString("utf8")).toBe("m-admin:good-secret");
            return {
              exitCode: 0,
              stdout: '{"error":"invalid_client","error_description":"basic auth disabled"}\n__terrarium_logto_http_status__:400',
              stderr: ""
            };
          }

          attemptedAuthMethods.push("post");
          const body = new URLSearchParams(String(options?.stdin ?? ""));
          expect(body.get("client_id")).toBe("m-admin");
          expect(body.get("client_secret")).toBe("good-secret");
          expect(body.get("resource")).toBe("https://admin.logto.app/api");
          return { exitCode: 0, stdout: '{"access_token":"management-token"}\n__terrarium_logto_http_status__:200', stderr: "" };
        }
      })
    );

    expect(token).toBe("management-token");
    expect(attemptedAuthMethods).toEqual(["basic", "post"]);
  });

  test("falls back from the default resource to the OSS admin resource for m-admin", async () => {
    const headersByPath = new Map<string, string>();
    const attemptedRequests: string[] = [];
    let headerCount = 0;

    const token = await requestLogtoManagementToken(
      "auth.example.test",
      "https://auth.example.test",
      [{ appId: "m-admin", secret: "good-secret" }],
      "https://default.logto.app/api",
      stubDeps({
        writeHeaderFile: (content, label) => {
          headerCount += 1;
          const path = `/tmp/terrarium-logto-sync-test-${label}-${headerCount}`;
          headersByPath.set(path, content);
          return { dir: `/tmp/terrarium-logto-sync-test-dir-${headerCount}`, path };
        },
        runAllowFailure: async (cmd, options) => {
          const headerFlagIndex = cmd.indexOf("-H");
          const headerPathArg = headerFlagIndex >= 0 ? cmd[headerFlagIndex + 1] ?? "" : "";
          const header = headersByPath.get(headerPathArg.replace(/^@/, "")) ?? "";
          const auth = header.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";
          const body = new URLSearchParams(String(options?.stdin ?? ""));
          const resource = body.get("resource") ?? "";
          const authMethod = auth ? "basic" : "post";
          attemptedRequests.push(`${authMethod}:${resource}`);

          if (resource === "https://default.logto.app/api") {
            return {
              exitCode: 0,
              stdout: '{"error":"invalid_client","error_description":"default resource rejected m-admin"}\n__terrarium_logto_http_status__:400',
              stderr: ""
            };
          }

          expect(resource).toBe("https://admin.logto.app/api");
          expect(authMethod).toBe("basic");
          expect(Buffer.from(auth, "base64").toString("utf8")).toBe("m-admin:good-secret");
          return { exitCode: 0, stdout: '{"access_token":"management-token"}\n__terrarium_logto_http_status__:200', stderr: "" };
        }
      })
    );

    expect(token).toBe("management-token");
    expect(attemptedRequests).toEqual([
      "basic:https://default.logto.app/api",
      "post:https://default.logto.app/api",
      "basic:https://admin.logto.app/api"
    ]);
  });

  test("tries the next Logto Management API candidate when m-admin is invalid", async () => {
    const headersByPath = new Map<string, string>();
    const attemptedRequests: string[] = [];
    let headerCount = 0;

    const token = await requestLogtoManagementToken(
      "auth.example.test",
      "https://auth.example.test",
      [
        { appId: "m-admin", secret: "bad-secret" },
        { appId: "seeded-m2m", secret: "good-secret" }
      ],
      "https://default.logto.app/api",
      stubDeps({
        writeHeaderFile: (content, label) => {
          headerCount += 1;
          const path = `/tmp/terrarium-logto-sync-test-${label}-${headerCount}`;
          headersByPath.set(path, content);
          return { dir: `/tmp/terrarium-logto-sync-test-dir-${headerCount}`, path };
        },
        runAllowFailure: async (cmd, options) => {
          const headerFlagIndex = cmd.indexOf("-H");
          const headerPathArg = headerFlagIndex >= 0 ? cmd[headerFlagIndex + 1] ?? "" : "";
          const header = headersByPath.get(headerPathArg.replace(/^@/, "")) ?? "";
          const auth = header.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";
          const credentials = auth ? Buffer.from(auth, "base64").toString("utf8") : "";
          const postBody = new URLSearchParams(String(options?.stdin ?? ""));
          const postCredentials = `${postBody.get("client_id")}:${postBody.get("client_secret")}`;
          const requestKey = auth ? `basic:${credentials}` : `post:${postCredentials}`;
          attemptedRequests.push(requestKey);

          if (requestKey === "basic:m-admin:bad-secret" || requestKey === "post:m-admin:bad-secret") {
            return {
              exitCode: 0,
              stdout: '{"error":"invalid_client","error_description":"invalid client m-admin"}\n__terrarium_logto_http_status__:400',
              stderr: ""
            };
          }
          if (requestKey === "basic:seeded-m2m:good-secret") {
            return { exitCode: 0, stdout: '{"access_token":"management-token"}\n__terrarium_logto_http_status__:200', stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: `unexpected request ${requestKey}` };
        }
      })
    );

    expect(token).toBe("management-token");
    expect(attemptedRequests).toEqual(["basic:m-admin:bad-secret", "post:m-admin:bad-secret", "basic:seeded-m2m:good-secret"]);
  });

  test("rejects Logto Management API token requests when no candidates exist", async () => {
    let invoked = false;

    await expect(
      requestLogtoManagementToken(
        "auth.example.test",
        "https://auth.example.test",
        [],
        "https://default.logto.app/api",
        stubDeps({
          runAllowFailure: async () => {
            invoked = true;
            return { exitCode: 1, stdout: "", stderr: "unexpected" };
          }
        })
      )
    ).rejects.toThrow("no Logto Management API candidate applications");
    expect(invoked).toBe(false);
  });

  test("redacts Logto Management API candidate secrets from token errors", async () => {
    const secret = "super-secret";
    const encodedSecret = Buffer.from(`m-admin:${secret}`, "utf8").toString("base64");
    const postBody = buildLogtoTokenRequest("https://auth.example.test", secret, "https://default.logto.app/api", "m-admin", "post").stdin;

    try {
      await requestLogtoManagementToken(
        "auth.example.test",
        "https://auth.example.test",
        [{ appId: "m-admin", secret }],
        "https://default.logto.app/api",
        stubDeps({
          runAllowFailure: async (_cmd, options) => ({
            exitCode: 0,
            stdout: `{"error":"invalid_client","error_description":"invalid client ${secret} ${encodedSecret} ${String(options?.stdin ?? "")}"}\n__terrarium_logto_http_status__:400`,
            stderr: ""
          }),
          writeHeaderFile: (content, label) => ({ dir: `/tmp/terrarium-logto-sync-test-${label}`, path: `/tmp/terrarium-logto-sync-test-${label}` })
        })
      );
      throw new Error("expected requestLogtoManagementToken to reject");
    } catch (error) {
      const message = String(error);
      expect(message).toContain("candidates tried: m-admin");
      expect(message).toContain("resources tried: https://default.logto.app/api, https://admin.logto.app/api");
      expect(message).toContain("m-admin [basic, resource=https://default.logto.app/api]");
      expect(message).toContain("m-admin [post, resource=https://admin.logto.app/api]");
      expect(message).toContain("invalid_client");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(encodedSecret);
      expect(message).not.toContain(postBody);
    }
  });

  test("defines stable Terrarium Logto applications and request bodies", () => {
    const apps = localLogtoOidcAppSpecs({
      terrarium_manage_domain: "manage.example.test",
      terrarium_proxy_domain: "proxy.example.test",
      terrarium_lxd_domain: "lxd.example.test"
    });
    const cockpit = apps.find((app) => app.outputPrefix === "cockpit");
    const lxd = apps.find((app) => app.outputPrefix === "lxd");
    const routes = apps.find((app) => app.outputPrefix === "routes");

    expect(apps.map((app) => app.name)).toEqual(["terrarium-cockpit", "terrarium-lxd", "terrarium-routes"]);
    expect(cockpit?.redirectUris).toEqual(["https://manage.example.test/oauth2/callback", "https://proxy.example.test/oauth2/callback"]);
    expect(lxd?.redirectUris).toEqual(["https://lxd.example.test/oidc/callback"]);
    expect(routes?.redirectUris).toEqual(["https://manage.example.test/oauth2/app/callback"]);
    expect(cockpit?.customData).toEqual({ terrarium: { managed: true, provider: "logto", app: "cockpit" } });
    expect(buildLogtoApplicationBody(cockpit!).oidcClientMetadata).toEqual({
      redirectUris: cockpit?.redirectUris,
      postLogoutRedirectUris: cockpit?.postLogoutRedirectUris
    });
  });

  test("matches managed Logto applications by marker before stable name fallback", () => {
    const [spec] = localLogtoOidcAppSpecs({});
    const marked = { id: "marked", name: "renamed", customData: { terrarium: { managed: true, provider: "logto", app: "cockpit" } } };
    const named = { id: "named", name: "terrarium-cockpit" };

    expect(matchesTerrariumLogtoApp(marked, "cockpit")).toBe(true);
    expect(findTerrariumLogtoApp([named, marked], spec)).toBe(marked);
    expect(findTerrariumLogtoApp([named], spec)).toBe(named);
    expect(() => findTerrariumLogtoApp([named, { id: "named-2", name: "terrarium-cockpit" }], spec)).toThrow("multiple Logto applications");
  });

  test("preserves a previous client secret only when the client id is retained", () => {
    const previous = {
      cockpit_client_id: { value: "client-1" },
      cockpit_client_secret: { value: "secret-1" }
    };

    expect(previousLogtoClientSecret(previous, "cockpit", "client-1")).toBe("secret-1");
    expect(previousLogtoClientSecret(previous, "cockpit", "client-2")).toBe("");
  });

  test("configures the local Logto sign-in experience for email password", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET" && path === "/api/sign-in-exp") {
        return {
          signIn: {
            methods: [{ identifier: "username", isPasswordPrimary: true, password: true, verificationCode: false }]
          },
          signUp: {
            identifiers: ["username"],
            password: true,
            verify: false
          }
        } as never;
      }
      if (method === "PATCH" && path === "/api/sign-in-exp") {
        return body as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await ensureEmailPasswordSignInExperience(api);

    expect(calls).toEqual([
      { method: "GET", path: "/api/sign-in-exp", body: undefined, query: undefined },
      {
        method: "PATCH",
        path: "/api/sign-in-exp",
        body: {
          signIn: {
            methods: [{ identifier: "email", isPasswordPrimary: true, password: true, verificationCode: false }]
          }
        },
        query: undefined
      }
    ]);
  });

  test("leaves the local Logto sign-up experience unchanged when sign-in already uses email password", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET" && path === "/api/sign-in-exp") {
        return {
          signIn: {
            methods: [{ identifier: "email", isPasswordPrimary: true, password: true, verificationCode: false }]
          },
          signUp: {
            identifiers: ["username"],
            password: true,
            verify: false
          }
        } as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await ensureEmailPasswordSignInExperience(api);

    expect(calls).toEqual([{ method: "GET", path: "/api/sign-in-exp", body: undefined, query: undefined }]);
  });

  test("leaves the local Logto sign-in experience unchanged when email password sign-in is already configured", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET" && path === "/api/sign-in-exp") {
        return {
          signIn: {
            methods: [{ identifier: "email", isPasswordPrimary: true, password: true, verificationCode: false }]
          },
          signUp: {
            identifiers: ["email"],
            password: true,
            verify: true
          }
        } as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await ensureEmailPasswordSignInExperience(api);

    expect(calls).toEqual([{ method: "GET", path: "/api/sign-in-exp", body: undefined, query: undefined }]);
  });

  test("ensures Logto admin roles idempotently", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET") {
        return [] as never;
      }
      return { id: "role-1", name: "terrarium-admins", type: "User" } as never;
    };

    expect(await ensureLogtoAdminRole(api, "terrarium-admins")).toMatchObject({ id: "role-1" });
    expect(calls).toEqual([
      { method: "GET", path: "/api/roles", body: undefined, query: { type: "User" } },
      {
        method: "POST",
        path: "/api/roles",
        body: { name: "terrarium-admins", description: "Terrarium management administrators", type: "User" },
        query: undefined
      }
    ]);
  });

  test("selects the local admin by exact Logto email and rejects missing or ambiguous users", () => {
    const users = [
      { id: "user-1", primaryEmail: "admin@example.test" },
      { id: "user-2", primaryEmail: "other@example.test" }
    ];

    expect(selectLogtoUserByEmail(users, "admin@example.test").id).toBe("user-1");
    expect(() => selectLogtoUserByEmail(users, "missing@example.test")).toThrow("failed to find Logto user");
    expect(() => selectLogtoUserByEmail([...users, { id: "user-3", email: "admin@example.test" }], "admin@example.test")).toThrow(
      "multiple Logto users"
    );
  });

  test("creates a missing Logto admin user with a username before assigning the admin role", async () => {
    const previousPassword = process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = "root-password";
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET" && path === "/api/users") {
        return [] as never;
      }
      if (method === "POST" && path === "/api/users") {
        return { id: "user-created" } as never;
      }
      if (path === "/api/users/user-created/roles") {
        if (method === "GET") {
          return [] as never;
        }
        return {} as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    try {
      await ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" });
    } finally {
      if (previousPassword === undefined) {
        delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
      } else {
        process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = previousPassword;
      }
    }

    expect(calls).toEqual([
      { method: "GET", path: "/api/users", body: undefined, query: { search: "admin@example.test" } },
      {
        method: "POST",
        path: "/api/users",
        body: {
          primaryEmail: "admin@example.test",
          username: "terrarium_admin",
          name: "Terrarium Admin",
          password: "root-password",
          emailVerified: true,
          customData: {
            terrarium: {
              managed: true,
              provider: "logto",
              user: "admin"
            }
          }
        },
        query: undefined
      },
      { method: "GET", path: "/api/users/user-created/roles", body: undefined, query: undefined },
      { method: "POST", path: "/api/users/user-created/roles", body: { roleIds: ["role-1"] }, query: undefined }
    ]);
  });

  test("creates a missing Logto admin user with the configured username", async () => {
    const previousPassword = process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = "root-password";
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (method === "GET" && path === "/api/users") {
        return [] as never;
      }
      if (method === "POST" && path === "/api/users") {
        return { id: "user-created" } as never;
      }
      if (path === "/api/users/user-created/roles") {
        if (method === "GET") {
          return [] as never;
        }
        return {} as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    try {
      await ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" }, "configured_admin");
    } finally {
      if (previousPassword === undefined) {
        delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
      } else {
        process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = previousPassword;
      }
    }

    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/users",
      body: {
        primaryEmail: "admin@example.test",
        username: "configured_admin",
        password: "root-password"
      }
    });
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/users/user-created/roles",
      body: { roleIds: ["role-1"] },
      query: undefined
    });
  });

  test("patches a missing username before assigning the admin role to a Terrarium-managed Logto user", async () => {
    const previousPassword = process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (path === "/api/users") {
        return [
          {
            id: "user-1",
            primaryEmail: "admin@example.test",
            customData: { terrarium: { managed: true, provider: "logto", user: "admin" } }
          }
        ] as never;
      }
      if (method === "PATCH" && path === "/api/users/user-1") {
        return { username: "configured_admin" } as never;
      }
      if (path === "/api/users/user-1/roles") {
        if (method === "GET") {
          return [] as never;
        }
        return {} as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    try {
      await ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" }, "configured_admin");
    } finally {
      if (previousPassword === undefined) {
        delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
      } else {
        process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = previousPassword;
      }
    }

    expect(calls).toEqual([
      { method: "GET", path: "/api/users", body: undefined, query: { search: "admin@example.test" } },
      { method: "PATCH", path: "/api/users/user-1", body: { username: "configured_admin" }, query: undefined },
      { method: "GET", path: "/api/users/user-1/roles", body: undefined, query: undefined },
      { method: "POST", path: "/api/users/user-1/roles", body: { roleIds: ["role-1"] }, query: undefined }
    ]);
  });

  test("refuses to assign the admin role to an unmarked user with the configured email", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (path === "/api/users") {
        return [{ id: "user-1", primaryEmail: "admin@example.test" }] as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await expect(
      ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" })
    ).rejects.toThrow("not marked as the Terrarium-managed admin");
    expect(calls).toEqual([{ method: "GET", path: "/api/users", body: undefined, query: { search: "admin@example.test" } }]);
  });

  test("requires the Logto admin password only when creating a missing user", async () => {
    const previousPassword = process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (path === "/api/users") {
        return [] as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    try {
      await expect(ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" })).rejects.toThrow(
        "TERRARIUM_LOGTO_ADMIN_PASSWORD is required to create missing Logto admin user admin@example.test"
      );
    } finally {
      if (previousPassword === undefined) {
        delete process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD;
      } else {
        process.env.TERRARIUM_LOGTO_ADMIN_PASSWORD = previousPassword;
      }
    }

    expect(calls).toEqual([{ method: "GET", path: "/api/users", body: undefined, query: { search: "admin@example.test" } }]);
  });

  test("preserves a non-empty existing Logto admin username instead of patching it", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (path === "/api/users") {
        return [
          {
            id: "user-1",
            primaryEmail: "admin@example.test",
            username: "existing_admin",
            customData: { terrarium: { managed: true, provider: "logto", user: "admin" } }
          }
        ] as never;
      }
      if (path === "/api/users/user-1/roles") {
        return [{ id: "role-1", name: "terrarium-admins", type: "User" }] as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" }, "configured_admin");
    expect(calls).toEqual([
      { method: "GET", path: "/api/users", body: undefined, query: { search: "admin@example.test" } },
      { method: "GET", path: "/api/users/user-1/roles", body: undefined, query: undefined }
    ]);
  });

  test("emits stable local IDP outputs with optional LXD secret", () => {
    const output = JSON.parse(
      buildLocalIdpOutputs(
        "default",
        {
          cockpit: { appId: "app-cockpit", clientId: "cockpit-client", clientSecret: "cockpit-secret" },
          lxd: { appId: "app-lxd", clientId: "lxd-client" },
          routes: { appId: "app-routes", clientId: "routes-client", clientSecret: "routes-secret" }
        },
        "https://auth.example.test/oidc"
      )
    );
    const outputWithLxdSecret = JSON.parse(
      buildLocalIdpOutputs(
        "default",
        {
          cockpit: { appId: "app-cockpit", clientId: "cockpit-client", clientSecret: "cockpit-secret" },
          lxd: { appId: "app-lxd", clientId: "lxd-client", clientSecret: "lxd-secret" },
          routes: { appId: "app-routes", clientId: "routes-client", clientSecret: "routes-secret" }
        },
        "https://auth.example.test/oidc"
      )
    );

    expect(output).toMatchObject({
      cockpit_client_id: { sensitive: true, type: "string", value: "cockpit-client" },
      cockpit_client_secret: { sensitive: true, type: "string", value: "cockpit-secret" },
      issuer: { sensitive: false, type: "string", value: "https://auth.example.test/oidc" },
      lxd_client_id: { sensitive: true, type: "string", value: "lxd-client" },
      project_id: { sensitive: false, type: "string", value: "default" },
      routes_client_id: { sensitive: true, type: "string", value: "routes-client" },
      routes_client_secret: { sensitive: true, type: "string", value: "routes-secret" }
    });
    expect(output.lxd_client_secret).toBeUndefined();
    expect(outputWithLxdSecret.lxd_client_secret).toEqual({ sensitive: true, type: "string", value: "lxd-secret" });
  });

  test("writes local Logto outputs with mode 0600", () => {
    const calls: Array<{ path: string; content: string; options?: { mode?: number } }> = [];
    writeLocalLogtoOutputs(
      "/etc/terrarium/local-idp.json",
      "default",
      {
        cockpit: { appId: "app-cockpit", clientId: "cockpit-client", clientSecret: "cockpit-secret" },
        lxd: { appId: "app-lxd", clientId: "lxd-client" },
        routes: { appId: "app-routes", clientId: "routes-client", clientSecret: "routes-secret" }
      },
      "https://auth.example.test/oidc",
      (path, content, options) => {
        calls.push({ path, content, options });
        return true;
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/etc/terrarium/local-idp.json");
    expect(calls[0].options).toEqual({ mode: 0o600 });
  });

  test("builds deterministic LXD OIDC commands with optional client secret", () => {
    const commands = buildLxdOidcConfigCommands({}, "https://auth.example.test/oidc", {
      appId: "app-lxd",
      clientId: "lxd-client",
      clientSecret: "lxd-secret"
    });
    const withoutSecret = buildLxdOidcConfigCommands({}, "https://auth.example.test/oidc", { appId: "app-lxd", clientId: "lxd-client" });

    expect(commands).toEqual([
      ["/snap/bin/lxc", "config", "set", "oidc.issuer", "https://auth.example.test/oidc"],
      ["/snap/bin/lxc", "config", "set", "oidc.client.id", "lxd-client"],
      ["/snap/bin/lxc", "config", "set", "oidc.groups.claim", "roles"],
      ["/snap/bin/lxc", "config", "set", "oidc.scopes", "openid profile email roles"],
      ["/snap/bin/lxc", "config", "set", "oidc.client.secret", "lxd-secret"]
    ]);
    expect(withoutSecret.some((cmd) => cmd.includes("oidc.client.secret"))).toBe(false);
  });

  test("can allocate and clean a temporary directory in the test environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-logto-sync-test-"));
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
