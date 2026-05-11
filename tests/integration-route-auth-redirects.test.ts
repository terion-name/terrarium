import { describe, expect, test } from "bun:test";
import { buildRouteAuthRedirectUris } from "../scripts/terrarium-traefik-sync";
import { expectedRouteAuthRedirectUris } from "./integration/scenarios/common";

const routeAuthConfig = {
  terrarium_root_domain: "example.test",
  terrarium_manage_domain: "manage.example.test",
  terrarium_auth_domain: "auth.example.test"
};

describe("integration route-auth redirect planning", () => {
  test("pre-registers the same route callback URIs that proxy sync will generate", () => {
    const labels = [
      "https://auth-run.example.test:8080@auth",
      "https://group-run.example.test:8080@auth:agents,admins",
      "https://*.example.test:8080@auth:admins~auth.example.test"
    ];

    const runtime = buildRouteAuthRedirectUris(labels, {
      ...routeAuthConfig,
      terrarium_acme_dns_provider: "cloudflare"
    });

    expect(runtime.errors).toEqual([]);
    expect(expectedRouteAuthRedirectUris(labels)).toEqual([...runtime.redirectUris].sort());
  });
});
