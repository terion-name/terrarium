import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyOidcConfig } from "./verify";

const originalFetch = globalThis.fetch;

function discoveryResponse(): Response {
  return Response.json({
    issuer: "https://issuer.example.test",
    authorization_endpoint: "https://issuer.example.test/oauth/v2/authorize",
    token_endpoint: "https://issuer.example.test/oauth/v2/token"
  });
}

function authResponse(): Response {
  return new Response("", {
    status: 302,
    headers: {
      location: "https://issuer.example.test/ui/login"
    }
  });
}

function oidcOptions() {
  return {
    issuer: "https://issuer.example.test",
    clientId: "client-id",
    clientSecret: "client-secret",
    manageDomain: "manage.example.test",
    proxyDomain: "proxy.example.test",
    lxdDomain: "lxd.example.test"
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OIDC verification", () => {
  test("rejects invalid_client instead of treating the secret as verified", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discoveryResponse();
      }
      if (url.includes("/oauth/v2/authorize")) {
        return authResponse();
      }
      return Response.json({ error: "invalid_client", error_description: "client not found" }, { status: 401 });
    }) as typeof fetch;

    await expect(verifyOidcConfig(oidcOptions())).rejects.toThrow("client not found");
  });

  test("rejects token errors that do not prove client authentication", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discoveryResponse();
      }
      if (url.includes("/oauth/v2/authorize")) {
        return authResponse();
      }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }) as typeof fetch;

    await expect(verifyOidcConfig(oidcOptions())).rejects.toThrow("unsupported_grant_type");
  });

  test("accepts invalid_grant after client authentication succeeds", async () => {
    const probedRedirectUris: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discoveryResponse();
      }
      if (url.includes("/oauth/v2/authorize")) {
        probedRedirectUris.push(new URL(url).searchParams.get("redirect_uri") ?? "");
        return authResponse();
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;

    await expect(verifyOidcConfig(oidcOptions())).resolves.toEqual({ issuer: "https://issuer.example.test" });
    expect(probedRedirectUris).toEqual([
      "https://manage.example.test/oauth2/callback",
      "https://proxy.example.test/oauth2/callback",
      "https://lxd.example.test/oidc/callback"
    ]);
  });

  test("accepts ZITADEL invalid-code responses after client authentication succeeds", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discoveryResponse();
      }
      if (url.includes("/oauth/v2/authorize")) {
        return authResponse();
      }
      return Response.json({ error: "Errors.User.Code.Invalid" }, { status: 400 });
    }) as typeof fetch;

    await expect(verifyOidcConfig(oidcOptions())).resolves.toEqual({ issuer: "https://issuer.example.test" });
  });

  test("returns the discovery issuer so LXD uses the exact provider value", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return discoveryResponse();
      }
      if (url.includes("/oauth/v2/authorize")) {
        return authResponse();
      }
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }) as typeof fetch;

    await expect(verifyOidcConfig({ ...oidcOptions(), issuer: "https://issuer.example.test/" })).resolves.toEqual({
      issuer: "https://issuer.example.test"
    });
  });

  test("rejects discovery documents for a different issuer", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://other-issuer.example.test",
          authorization_endpoint: "https://issuer.example.test/oauth/v2/authorize",
          token_endpoint: "https://issuer.example.test/oauth/v2/token"
        });
      }
      return authResponse();
    }) as typeof fetch;

    await expect(verifyOidcConfig(oidcOptions())).rejects.toThrow("OIDC discovery issuer mismatch");
  });
});

describe("AWS CLI fallback installer", () => {
  test("uses a pinned archive and private staging directories", () => {
    const source = readFileSync(join(import.meta.dir, "verify.ts"), "utf8");

    expect(source).toContain('const AWS_CLI_VERSION = "2.34.41"');
    expect(source).toContain('const AWS_CLI_DOWNLOAD_DIR = "/var/lib/terrarium/downloads/awscli"');
    expect(source).toContain('const AWS_CLI_STAGE_DIR = "/var/lib/terrarium/staging/awscli"');
    expect(source).toContain("AWS_CLI_SHA256");
    expect(source).toContain("validateAwsCliArchive");
    expect(source).toContain("validateAwsCliZipPath");
    expect(source).toContain("unsafe AWS CLI archive member type");
    expect(source).toContain("awscli-exe-linux-${fallbackArch}-${AWS_CLI_VERSION}.zip");
    expect(source).not.toContain("terrarium-awscli-install-");
  });
});
