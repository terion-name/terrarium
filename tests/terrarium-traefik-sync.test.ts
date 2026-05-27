import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  buildDynamicConfig,
  assertProxySyncSucceeded,
  buildRouteAuthComposeArtifacts,
  buildRouteAuthProfiles,
  buildRouteAuthRedirectUris,
  formatRouteAuthReadinessError,
  isZitadelNoChangesResponse,
  parseZitadelHttpOutput
} from "../scripts/terrarium-traefik-sync";
import { buildZitadelCloudRedirectUris } from "./integration/provider/zitadel-cloud";

const repoRoot = join(import.meta.dir, "..");

const routeAuthConfig = {
  terrarium_root_domain: "example.test",
  terrarium_manage_domain: "manage.example.test",
  terrarium_proxy_domain: "proxy.example.test",
  terrarium_auth_domain: "auth.example.test",
  terrarium_oidc_issuer: "https://auth.example.test",
  terrarium_oauth2_proxy_gid: "47201"
};
const OAUTH2_PROXY_DHI_IMAGE =
  "dhi.io/oauth2-proxy:7.15.2-debian13@sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const OAUTH2_PROXY_MIRROR_IMAGE =
  "ghcr.io/terion-name/terrarium-dhi-oauth2-proxy:7.15.2-debian13@sha256:c5ec2ff7b486e72e7e6868efdc4c058f6280dba2ea472751c639d7b0e2bd43de";

function container(name: string, proxy: string, address = "10.10.0.10") {
  return {
    name,
    config: {
      "user.proxy": proxy
    },
    state: {
      network: {
        eth0: {
          addresses: [
            {
              family: "inet",
              scope: "global",
              address
            }
          ]
        }
      }
    }
  };
}

function profileByGroups(profiles: ReturnType<typeof buildRouteAuthProfiles>["profiles"], groups: string[]) {
  const key = groups.join(",");
  const profile = profiles.find((candidate) => candidate.groups.join(",") === key);
  if (!profile) {
    throw new Error(`missing profile for groups: ${key}`);
  }
  return profile;
}

describe("terrarium route auth generation", () => {
  test("parses ZITADEL API bodies separately from curl's status trailer", () => {
    expect(parseZitadelHttpOutput('{"error":"bad request"}\n__terrarium_http_status__:400')).toEqual({
      status: 400,
      body: '{"error":"bad request"}'
    });
  });

  test("reads local ZITADEL bootstrap material from the managed LXD instance", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-traefik-sync.ts"), "utf8");

    expect(source).toContain('const DEFAULT_ZITADEL_INSTANCE_NAME = "terrarium-idp"');
    expect(source).toContain('runAllowFailure(["lxc", "exec", instanceName, "--", "cat", patPath])');
    expect(source).toContain("readLocalZitadelPat(config)");
  });

  test("uses HTTP ACME challenges in generated Traefik static config", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-traefik-sync.ts"), "utf8");

    expect(source).toContain("acme.httpChallenge = { entryPoint: \"web\" }");
    expect(source).toContain('entryPoint: "web"');
    expect(source).not.toContain("tlsChallenge:");
  });

  test("switches generated Traefik static config to DNS-01 when a lego provider is configured", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-traefik-sync.ts"), "utf8");
    expect(source).toContain("acme.dnsChallenge = { provider: dnsProvider }");
  });

  test("treats ZITADEL no-op updates as successful idempotent responses", () => {
    expect(
      isZitadelNoChangesResponse(
        400,
        '{"code":9,"message":"No changes (COMMAND-1m88i)","details":[{"id":"COMMAND-1m88i","message":"No changes"}]}'
      )
    ).toBe(true);
    expect(isZitadelNoChangesResponse(400, '{"code":3,"message":"invalid argument"}')).toBe(false);
  });

  test("creates path-aware oauth2-proxy profiles and rejects conflicting path policies", () => {
    const { profiles, errors } = buildRouteAuthProfiles(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("other-admin", "https://app.example.test:8081/other-admin@auth:admins"),
        container("agents", "https://agents.example.test:8082/agents@auth:agents")
      ],
      routeAuthConfig
    );

    expect(errors).toEqual([]);
    expect(profiles).toHaveLength(3);
    expect(profiles.map((profile) => profile.host)).toEqual(["agents.example.test", "app.example.test", "app.example.test"]);
    expect(profiles.map((profile) => profile.path)).toEqual(["/agents", "/admin", "/other-admin"]);
    expect(profiles.map((profile) => profile.groups)).toEqual([["agents"], ["admins"], ["admins"]]);
    expect(profiles.map((profile) => profile.callbackPath)).toEqual([
      "/oauth2/agents/callback",
      "/oauth2/admin/callback",
      "/oauth2/other-admin/callback"
    ]);
    expect(profiles.map((profile) => profile.containerName)).toEqual([
      "route-agents-example-test-agents",
      "route-app-example-test-admin",
      "route-app-example-test-other-admin"
    ]);

    const conflict = buildRouteAuthProfiles(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("agents", "https://app.example.test:8081/admin@auth:agents")
      ],
      routeAuthConfig
    );
    expect(conflict.profiles).toHaveLength(1);
    expect(conflict.errors).toContain("agents: auth-protected routes for app.example.test/admin must use one group policy; found admins and agents");
  });

  test("allows managed auth routes under the management parent domain when root domain is not saved", () => {
    const { profiles, errors } = buildRouteAuthProfiles(
      [container("hermes", "https://nokt-kernel.agents.terion.dev:9119@auth:admins,https://nokt-kernel-api.agents.terion.dev:8642")],
      {
        ...routeAuthConfig,
        terrarium_root_domain: "",
        terrarium_manage_domain: "manage.agents.terion.dev"
      }
    );

    expect(errors).toEqual([]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].host).toBe("nokt-kernel.agents.terion.dev");
    expect(profiles[0].groups).toEqual(["admins"]);
  });

  test("writes group policy into oauth2-proxy config instead of compose labels or environment", () => {
    const { profiles } = buildRouteAuthProfiles(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("signed-in", "https://signed.example.test:8082/signed-in@auth")
      ],
      routeAuthConfig
    );

    const { composeYaml, profileConfigs } = buildRouteAuthComposeArtifacts(
      routeAuthConfig,
      profiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );
    const adminProfile = profileByGroups(profiles, ["admins"]);
    const signedInProfile = profileByGroups(profiles, []);
    const compose = parse(composeYaml) as { services: Record<string, unknown> };

    expect(Object.keys(compose.services).sort()).toEqual(profiles.map((profile) => profile.containerName).sort());
    expect(Object.values(compose.services).map((service) => (service as { image?: string }).image)).toEqual(
      profiles.map(() => OAUTH2_PROXY_MIRROR_IMAGE)
    );
    expect(Object.values(compose.services).map((service) => (service as { user?: string }).user)).toEqual(profiles.map(() => "65532:47201"));
    expect(profileConfigs[adminProfile.containerName]).toContain(`proxy_prefix = "${adminProfile.proxyPrefix}"`);
    expect(profileConfigs[adminProfile.containerName]).toContain(`redirect_url = "${adminProfile.callbackPath}"`);
    expect(profileConfigs[adminProfile.containerName]).toContain('allowed_groups = [ "admins" ]');
    expect(profileConfigs[adminProfile.containerName]).toContain(`cookie_name = "__Host-terrarium_route_${adminProfile.containerName.replace(/^route-/, "")}"`);
    expect(profileConfigs[adminProfile.containerName]).toContain('cookie_path = "/"');
    expect(profileConfigs[adminProfile.containerName]).toContain('whitelist_domains = [ "app.example.test" ]');
    expect(profileConfigs[adminProfile.containerName]).toContain('trusted_proxy_ips = [ "127.0.0.1/32", "::1/128" ]');
    expect(profileConfigs[adminProfile.containerName]).not.toContain("cookie_domains");
    expect(profileConfigs[signedInProfile.containerName]).toContain(`proxy_prefix = "${signedInProfile.proxyPrefix}"`);
    expect(profileConfigs[signedInProfile.containerName]).toContain(`cookie_name = "__Host-terrarium_route_${signedInProfile.containerName.replace(/^route-/, "")}"`);
    expect(profileConfigs[signedInProfile.containerName]).not.toContain("allowed_groups");
    expect(profileConfigs[adminProfile.containerName]).not.toContain(`cookie_name = "__Host-terrarium_route_${signedInProfile.containerName.replace(/^route-/, "")}"`);
  });

  test("uses a provisioned host group gid for route-auth oauth2-proxy config access", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-traefik-sync.ts"), "utf8");
    const { profiles } = buildRouteAuthProfiles([container("admin", "https://app.example.test:8080/admin@auth:admins")], routeAuthConfig);
    const { composeYaml } = buildRouteAuthComposeArtifacts(
      { ...routeAuthConfig, terrarium_oauth2_proxy_uid: "61000", terrarium_oauth2_proxy_gid: "61001" },
      profiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );
    const compose = parse(composeYaml) as { services: Record<string, { user?: string }> };

    expect(Object.values(compose.services).map((service) => service.user)).toEqual(["61000:61001"]);
    expect(source).toContain('const DEFAULT_OAUTH2_PROXY_GROUP = "terrarium-oauth2-proxy"');
    expect(source).toContain('runAllowFailure(["getent", "group", groupName])');
    expect(source).not.toContain("const OAUTH2_PROXY_GID = 65532");
    expect(source).not.toContain("chownSync(configPath, 0, OAUTH2_PROXY_GID)");
  });

  test("allows route-auth oauth2-proxy image overrides for mirrors", () => {
    const { profiles } = buildRouteAuthProfiles([container("admin", "https://app.example.test:8080/admin@auth:admins")], routeAuthConfig);
    const { composeYaml } = buildRouteAuthComposeArtifacts(
      { ...routeAuthConfig, terrarium_oauth2_proxy_image: "registry.example.test/oauth2-proxy:test" },
      profiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );
    const compose = parse(composeYaml) as { services: Record<string, { image?: string }> };

    expect(Object.values(compose.services).map((service) => service.image)).toEqual(["registry.example.test/oauth2-proxy:test"]);
  });

  test("allows route-auth oauth2-proxy image overrides for Docker Hardened Images", () => {
    const { profiles } = buildRouteAuthProfiles([container("admin", "https://app.example.test:8080/admin@auth:admins")], routeAuthConfig);
    const { composeYaml } = buildRouteAuthComposeArtifacts(
      { ...routeAuthConfig, terrarium_oauth2_proxy_image: OAUTH2_PROXY_DHI_IMAGE },
      profiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );
    const compose = parse(composeYaml) as { services: Record<string, { image?: string }> };

    expect(Object.values(compose.services).map((service) => service.image)).toEqual([OAUTH2_PROXY_DHI_IMAGE]);
  });

  test("uses the exact local ZITADEL discovery issuer for route auth", () => {
    const { profiles } = buildRouteAuthProfiles([container("admin", "https://app.example.test:8080/admin@auth")], {
      ...routeAuthConfig,
      terrarium_idp_mode: "local",
      terrarium_oidc_issuer: "https://auth.example.test/"
    });
    const { profileConfigs } = buildRouteAuthComposeArtifacts(
      { ...routeAuthConfig, terrarium_idp_mode: "local", terrarium_oidc_issuer: "https://auth.example.test/" },
      profiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );

    expect(Object.values(profileConfigs)[0]).toContain('oidc_issuer_url = "https://auth.example.test"');
    expect(Object.values(profileConfigs)[0]).not.toContain('oidc_issuer_url = "https://auth.example.test/"');
  });

  test("generates policy-specific forwardAuth middleware and oauth callback routes without query policy", () => {
    const { dynamicYaml, authProfiles, errors } = buildDynamicConfig(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("agents", "https://agents.example.test:8081/agents@auth:agents")
      ],
      routeAuthConfig
    );
    const dynamic = parse(dynamicYaml) as {
      http: {
        middlewares: Record<string, { forwardAuth?: { address: string } }>;
        routers: Record<string, { rule: string; service: string }>;
      };
    };

    expect(errors).toEqual([]);
    expect(authProfiles).toHaveLength(2);

    for (const profile of authProfiles) {
      expect(dynamic.http.middlewares[profile.middlewareName].forwardAuth?.address).toBe(`http://127.0.0.1:${profile.port}/`);
      expect(dynamic.http.middlewares[profile.middlewareName].forwardAuth?.address).not.toContain("?");
      expect(dynamic.http.middlewares[profile.middlewareName].forwardAuth?.address).not.toContain("allowed_groups");

      const oauthRules = Object.values(dynamic.http.routers)
        .filter((router) => router.service === profile.serviceName)
        .map((router) => router.rule);
      expect(oauthRules.some((rule) => rule.includes(`PathPrefix(\`${profile.proxyPrefix}/\`)`))).toBe(true);
    }
  });

  test("renders wildcard HTTPS routes with HostRegexp and wildcard ACME domains", () => {
    const { dynamicYaml, errors } = buildDynamicConfig(
      [container("app", "https://*.example.test:8080")],
      { ...routeAuthConfig, terrarium_acme_dns_provider: "cloudflare" }
    );
    const dynamic = parse(dynamicYaml) as {
      http: {
        routers: Record<string, { rule: string; tls?: { certResolver?: string; domains?: Array<{ main: string; sans: string[] }> } }>;
      };
    };
    const httpsRouter = Object.values(dynamic.http.routers).find((router) => router.tls);

    expect(errors).toEqual([]);
    expect(httpsRouter?.rule).toBe("HostRegexp(`^[^.]+\\.example\\.test$`)");
    expect(httpsRouter?.tls).toEqual({
      certResolver: "letsencrypt",
      domains: [{ main: "example.test", sans: ["*.example.test"] }]
    });
  });

  test("rejects wildcard HTTPS routes until DNS-01 is configured", () => {
    const { errors } = buildDynamicConfig([container("app", "https://*.example.test:8080")], routeAuthConfig);

    expect(errors).toContain("app: wildcard HTTPS route https://*.example.test:8080 requires DNS-01 ACME; run terrariumctl set dns provider <provider> KEY:VALUE");
  });

  test("uses a concrete callback host and shared cookie domain for wildcard route auth", () => {
    const { dynamicYaml, authProfiles, errors } = buildDynamicConfig(
      [container("admin", "https://*.example.test:8080@auth:admins~auth.example.test")],
      { ...routeAuthConfig, terrarium_acme_dns_provider: "cloudflare" }
    );
    const dynamic = parse(dynamicYaml) as {
      http: {
        routers: Record<string, { rule: string; service: string }>;
      };
    };
    const { profileConfigs } = buildRouteAuthComposeArtifacts(
      { ...routeAuthConfig, terrarium_acme_dns_provider: "cloudflare" },
      authProfiles,
      "routes-client",
      "routes-secret",
      "0123456789abcdef"
    );
    const profile = authProfiles[0];

    expect(errors).toEqual([]);
    expect(profile.callbackHost).toBe("auth.example.test");
    expect(Object.values(dynamic.http.routers).some((router) => router.rule === `Host(\`auth.example.test\`) && PathPrefix(\`${profile.proxyPrefix}/\`)`)).toBe(true);
    expect(profileConfigs[profile.containerName]).toContain(`redirect_url = "https://auth.example.test${profile.callbackPath}"`);
    expect(profileConfigs[profile.containerName]).toContain('cookie_domains = [ ".example.test" ]');
    expect(profileConfigs[profile.containerName]).toContain('whitelist_domains = [ ".example.test" ]');
    expect(profileConfigs[profile.containerName]).toContain('cookie_name = "terrarium_route_');
    expect(profileConfigs[profile.containerName]).not.toContain('cookie_name = "__Host-');
  });

  test("uses reconciled backend targets when LXD uses host-side proxy devices", () => {
    const { dynamicYaml, errors } = buildDynamicConfig(
      [container("app", "https://app.example.test:8080")],
      routeAuthConfig,
      { "app:tcp:8080": { address: "127.0.0.1", port: 18081 } }
    );
    const dynamic = parse(dynamicYaml) as {
      http: {
        services: Record<string, { loadBalancer: { servers: { url: string }[] } }>;
      };
    };

    expect(errors).toEqual([]);
    expect(Object.values(dynamic.http.services)[0].loadBalancer.servers[0].url).toBe("http://127.0.0.1:18081");
  });

  test("external ZITADEL redirect URIs include predictable route callback paths", () => {
    const { redirectUris, errors } = buildRouteAuthRedirectUris(
      [
        "https://app.example.test:8080/admin@auth:admins",
        "https://agents.example.test:8081/agents@auth:agents"
      ],
      routeAuthConfig
    );
    const providerRedirectUris = buildZitadelCloudRedirectUris(
      {
        manage: "manage.example.test",
        proxy: "proxy.example.test",
        lxd: "lxd.example.test",
        auth: "auth.example.test"
      },
      redirectUris
    );

    expect(errors).toEqual([]);
    expect(providerRedirectUris).toContain("https://manage.example.test/oauth2/callback");
    expect(providerRedirectUris).toContain("https://proxy.example.test/oauth2/callback");
    expect(providerRedirectUris).toContain("https://manage.example.test/oauth2/app/callback");
    expect(providerRedirectUris).toContain("https://lxd.example.test/oidc/callback");
    expect(
      buildZitadelCloudRedirectUris(
        {
          manage: "manage.example.test",
          proxy: "proxy.example.test",
          lxd: "lxd.example.test",
          auth: "auth.example.test"
        },
        ["legacy.example.test"]
      )
    ).toContain("https://legacy.example.test/oauth2/callback");
    expect(redirectUris).toEqual(["https://agents.example.test/oauth2/agents/callback", "https://app.example.test/oauth2/admin/callback"]);
    expect(providerRedirectUris).toContain("https://agents.example.test/oauth2/agents/callback");
    expect(providerRedirectUris).toContain("https://app.example.test/oauth2/admin/callback");
    expect(providerRedirectUris).not.toContain("https://app.example.test/oauth2/route/app-example-test-admins/callback");
  });
});

describe("terrarium proxy sync failure handling", () => {
  test("writes dynamic auth routers before route-auth sidecar readiness can abort", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-traefik-sync.ts"), "utf8");
    const dynamicWrite = source.indexOf("writeIfChanged(DYNAMIC_CONFIG_PATH, dynamicYaml)");
    const routeAuthSync = source.indexOf("const routeAuthErrors = await syncRouteAuthStack(config, authProfiles)");

    expect(dynamicWrite).toBeGreaterThan(0);
    expect(routeAuthSync).toBeGreaterThan(dynamicWrite);
  });

  test("throws one failure message when any sync error group is non-empty", () => {
    expect(() =>
      assertProxySyncSucceeded({
        dynamicErrors: ["app: duplicate HTTP route https://app.example.test/"],
        ufwErrors: ["failed to add UFW rule tcp/2222: permission denied"],
        backendErrors: ["failed to add LXD proxy device"],
        localRouteClientErrors: ["failed to find terrarium-routes app in ZITADEL"],
        routeAuthErrors: ["route auth listener failed readiness probe"]
      })
    ).toThrow(
      [
        "proxy sync failed:",
        "- dynamic config: app: duplicate HTTP route https://app.example.test/",
        "- ufw: failed to add UFW rule tcp/2222: permission denied",
        "- backend: failed to add LXD proxy device",
        "- local route client: failed to find terrarium-routes app in ZITADEL",
        "- route auth: route auth listener failed readiness probe"
      ].join("\n")
    );
  });

  test("does not throw when sync error groups are empty", () => {
    expect(() => assertProxySyncSucceeded({})).not.toThrow();
  });

  test("formats route auth readiness errors with profile identity and last probe output", () => {
    const message = formatRouteAuthReadinessError(
      {
        host: "app.example.test",
        groups: ["admins", "operators"],
        port: 4182
      },
      "http://127.0.0.1:4182/ping",
      {
        stderr: "curl: (7) Failed to connect",
        stdout: ""
      }
    );

    expect(message).toContain("host=app.example.test groups=admins,operators port=4182");
    expect(message).toContain("http://127.0.0.1:4182/ping");
    expect(message).toContain('last stderr/stdout: stderr="curl: (7) Failed to connect" stdout="<empty>"');
  });
});
