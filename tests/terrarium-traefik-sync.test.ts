import { describe, expect, test } from "bun:test";
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

const routeAuthConfig = {
  terrarium_root_domain: "example.test",
  terrarium_manage_domain: "manage.example.test",
  terrarium_proxy_domain: "proxy.example.test",
  terrarium_auth_domain: "auth.example.test",
  terrarium_oidc_issuer: "https://auth.example.test"
};

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

  test("treats ZITADEL no-op updates as successful idempotent responses", () => {
    expect(
      isZitadelNoChangesResponse(
        400,
        '{"code":9,"message":"No changes (COMMAND-1m88i)","details":[{"id":"COMMAND-1m88i","message":"No changes"}]}'
      )
    ).toBe(true);
    expect(isZitadelNoChangesResponse(400, '{"code":3,"message":"invalid argument"}')).toBe(false);
  });

  test("deduplicates oauth2-proxy profiles by host and group policy", () => {
    const { profiles, errors } = buildRouteAuthProfiles(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("agents", "https://app.example.test:8081/agents@auth:agents"),
        container("signed-in", "https://app.example.test:8082/signed-in@auth")
      ],
      routeAuthConfig
    );

    expect(errors).toEqual([]);
    expect(profiles).toHaveLength(3);
    expect(profiles.map((profile) => profile.host)).toEqual(["app.example.test", "app.example.test", "app.example.test"]);
    expect(profiles.map((profile) => profile.groups)).toEqual([[], ["admins"], ["agents"]]);
    expect(new Set(profiles.map((profile) => profile.key)).size).toBe(3);
    expect(new Set(profiles.map((profile) => profile.callbackPath)).size).toBe(3);
    expect(new Set(profiles.map((profile) => profile.containerName)).size).toBe(3);
    expect(new Set(profiles.map((profile) => profile.serviceName)).size).toBe(3);
    expect(new Set(profiles.map((profile) => profile.middlewareName)).size).toBe(3);
  });

  test("writes group policy into oauth2-proxy config instead of compose labels or environment", () => {
    const { profiles } = buildRouteAuthProfiles(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("signed-in", "https://app.example.test:8082/signed-in@auth")
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
    expect(profileConfigs[adminProfile.containerName]).toContain(`proxy_prefix = "${adminProfile.proxyPrefix}"`);
    expect(profileConfigs[adminProfile.containerName]).toContain(
      `redirect_url = "https://app.example.test${adminProfile.callbackPath}"`
    );
    expect(profileConfigs[adminProfile.containerName]).toContain('allowed_groups = [ "admins" ]');
    expect(profileConfigs[adminProfile.containerName]).toContain(`cookie_name = "_terrarium_route_${adminProfile.containerName.replace(/^route-/, "")}"`);
    expect(profileConfigs[signedInProfile.containerName]).toContain(`proxy_prefix = "${signedInProfile.proxyPrefix}"`);
    expect(profileConfigs[signedInProfile.containerName]).toContain(`cookie_name = "_terrarium_route_${signedInProfile.containerName.replace(/^route-/, "")}"`);
    expect(profileConfigs[signedInProfile.containerName]).not.toContain("allowed_groups");
    expect(profileConfigs[adminProfile.containerName]).not.toContain(`cookie_name = "_terrarium_route_${signedInProfile.containerName.replace(/^route-/, "")}"`);
  });

  test("generates policy-specific forwardAuth middleware and oauth callback routes without query policy", () => {
    const { dynamicYaml, authProfiles, errors } = buildDynamicConfig(
      [
        container("admin", "https://app.example.test:8080/admin@auth:admins"),
        container("agents", "https://app.example.test:8081/agents@auth:agents")
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
      expect(oauthRules.some((rule) => rule.includes("PathPrefix(`/oauth2/`)"))).toBe(false);
    }
  });

  test("external ZITADEL redirect URIs include exact generated route callback paths", () => {
    const { redirectUris, errors } = buildRouteAuthRedirectUris(
      [
        "https://app.example.test:8080/admin@auth:admins",
        "https://app.example.test:8081/agents@auth:agents"
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
    for (const redirectUri of redirectUris) {
      expect(redirectUri).toMatch(/^https:\/\/app\.example\.test\/oauth2\/route\/.+\/callback$/);
      expect(providerRedirectUris).toContain(redirectUri);
    }
    expect(providerRedirectUris).not.toContain("https://app.example.test/oauth2/callback");
  });
});

describe("terrarium proxy sync failure handling", () => {
  test("throws one failure message when any sync error group is non-empty", () => {
    expect(() =>
      assertProxySyncSucceeded({
        dynamicErrors: ["app: duplicate HTTP route https://app.example.test/"],
        ufwErrors: ["failed to add UFW rule tcp/2222: permission denied"],
        localRouteClientErrors: ["failed to find terrarium-routes app in ZITADEL"],
        routeAuthErrors: ["route auth listener failed readiness probe"]
      })
    ).toThrow(
      [
        "proxy sync failed:",
        "- dynamic config: app: duplicate HTTP route https://app.example.test/",
        "- ufw: failed to add UFW rule tcp/2222: permission denied",
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
