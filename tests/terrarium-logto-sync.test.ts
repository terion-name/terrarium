import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLocalIdpOutputs,
  buildLogtoApplicationBody,
  buildLogtoCurlCommand,
  buildLogtoPostgresSecretCommand,
  buildLogtoRuntime,
  buildLogtoTokenRequest,
  buildLxdOidcConfigCommands,
  ensureLogtoAdminRole,
  ensureLogtoAdminUserRole,
  findTerrariumLogtoApp,
  idpSyncCmd,
  isRetriableLogtoApiError,
  localLogtoOidcAppSpecs,
  matchesTerrariumLogtoApp,
  parseLogtoHttpOutput,
  parsePsqlSingleSecretOutput,
  previousLogtoClientSecret,
  redactLogtoSecrets,
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

  test("builds deterministic managed and host Postgres secret commands", () => {
    const runtime = buildLogtoRuntime({ terrarium_logto_instance_name: "custom-logto" });
    const managed = buildLogtoPostgresSecretCommand(runtime, true);
    const host = buildLogtoPostgresSecretCommand(runtime, false);

    expect(managed.cmd.slice(0, 4)).toEqual(["lxc", "exec", "custom-logto", "--"]);
    expect(managed.cmd).toContain("terrarium-logto");
    expect(managed.cmd).toContain("/var/lib/terrarium/logto/docker-compose.yml");
    expect(managed.cmd).toContain("-t");
    expect(managed.cmd).toContain("-A");
    expect(managed.cmd).toContain("select secret from applications where id = 'm-admin'");
    expect(host.cmd.slice(0, 2)).toEqual(["docker", "compose"]);
    expect(host.cwd).toBe("/var/lib/terrarium/logto");
  });

  test("parses exactly one m-admin secret from psql output", () => {
    expect(parsePsqlSingleSecretOutput("\n secret-1 \n")).toBe("secret-1");
    expect(() => parsePsqlSingleSecretOutput("\n\n")).toThrow("failed to read Logto m-admin secret");
    expect(() => parsePsqlSingleSecretOutput("secret-1\nsecret-2\n")).toThrow("multiple rows");
  });

  test("builds the Logto management token request with Basic auth and form stdin", () => {
    const request = buildLogtoTokenRequest("https://auth.example.test/", "secret-1");
    const auth = request.headers.match(/^Authorization: Basic (.+)$/m)?.[1] ?? "";

    expect(request.url).toBe("https://auth.example.test/oidc/token");
    expect(Buffer.from(auth, "base64").toString("utf8")).toBe("m-admin:secret-1");
    expect(request.stdin).toContain("grant_type=client_credentials");
    expect(request.stdin).toContain("resource=https%3A%2F%2Fdefault.logto.app%2Fapi");
    expect(request.stdin).toContain("scope=all");
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

  test("skips Logto user role assignment when the role is already present", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string> }> = [];
    const api: LogtoApiCall = async (method, path, body, query) => {
      calls.push({ method, path, body, query });
      if (path === "/api/users") {
        return [{ id: "user-1", primaryEmail: "admin@example.test" }] as never;
      }
      if (path === "/api/users/user-1/roles") {
        return [{ id: "role-1", name: "terrarium-admins", type: "User" }] as never;
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await ensureLogtoAdminUserRole(api, "admin@example.test", { id: "role-1", name: "terrarium-admins", type: "User" });
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
