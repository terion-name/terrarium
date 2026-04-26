import { afterEach, describe, expect, test } from "bun:test";
import { verifyOidcConfig } from "./verify";

const originalFetch = globalThis.fetch;

function discoveryResponse(): Response {
  return Response.json({
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

    await expect(verifyOidcConfig(oidcOptions())).resolves.toBeUndefined();
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

    await expect(verifyOidcConfig(oidcOptions())).resolves.toBeUndefined();
  });
});
