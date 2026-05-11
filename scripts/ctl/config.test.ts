import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetDnsProviderConfig, applySetIdpConfig, parseSetCommandOptions, runReconcileActions, type ReconcileActions } from "./config";

function recordActions(calls: string[], outputs: string[] = [""]): ReconcileActions {
  return {
    reconfigure: async () => {
      calls.push("reconfigure");
    },
    syncIdp: async () => {
      calls.push("syncIdp");
    },
    syncProxy: async () => {
      calls.push("syncProxy");
    },
    readLocalIdpOutputs: async () => {
      return outputs.shift() ?? outputs.at(-1) ?? "";
    }
  };
}

describe("terrariumctl config reconciliation", () => {
  test("recovers exact numeric-looking client IDs from argv when cac coerces them", () => {
    const originalArgv = process.argv;
    const clientId = "370342054720506035";
    const lxdClientId = "370342055777410480";
    process.argv = [
      "terrariumctl",
      "set",
      "idp",
      "oidc",
      "--oidc-client",
      clientId,
      "--lxd-oidc-client",
      lxdClientId
    ];

    try {
      const parsed = parseSetCommandOptions({
        oidcClient: Number(clientId),
        lxdOidcClient: Number(lxdClientId)
      });

      expect(parsed.idp.oidcClient).toBe(clientId);
      expect(parsed.idp.lxdOidcClient).toBe(lxdClientId);
    } finally {
      process.argv = originalArgv;
    }
  });

  test("syncs local IDP outputs before proxy config convergence finishes", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "local" }, recordActions(calls, ["same", "same"]));

    expect(calls).toEqual(["reconfigure", "syncIdp", "syncProxy"]);
  });

  test("reruns Ansible when local IDP sync changes oauth client outputs", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "local" }, recordActions(calls, ["old-client", "new-client", "new-client", "new-client"]));

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "syncProxy"]);
  });

  test("keeps rerunning Ansible until final local IDP outputs are consumed", async () => {
    const calls: string[] = [];

    await runReconcileActions(
      { terrarium_idp_mode: "local" },
      recordActions(calls, ["old-client", "mid-client", "mid-client", "new-client", "new-client", "new-client"])
    );

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "syncProxy"]);
  });

  test("fails instead of continuing when local IDP outputs never stabilize", async () => {
    const calls: string[] = [];

    await expect(
      runReconcileActions(
        { terrarium_idp_mode: "local" },
        recordActions(calls, ["client-1", "client-2", "client-2", "client-3", "client-3", "client-4", "client-4", "client-5"])
      )
    ).rejects.toThrow("local IDP outputs kept changing");

    expect(calls).toEqual(["reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure", "syncIdp", "reconfigure"]);
  });

  test("skips IDP sync for external OIDC mode", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "oidc" }, recordActions(calls));

    expect(calls).toEqual(["reconfigure", "syncProxy"]);
  });

  test("preserves the local auth domain when switching to external OIDC", () => {
    const config: Record<string, unknown> = {
      terrarium_public_ip: "203.0.113.10",
      terrarium_root_domain: "example.test",
      terrarium_manage_domain: "primary-manage.example.test",
      terrarium_proxy_domain: "primary-proxy.example.test",
      terrarium_lxd_domain: "primary-lxd.example.test",
      terrarium_auth_domain: "primary-auth.example.test",
      terrarium_admin_group: "terrarium-admins"
    };

    const plan = applySetIdpConfig(config, {
      mode: "oidc",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(config.terrarium_auth_domain).toBe("primary-auth.example.test");
    expect(config.terrarium_oidc_issuer).toBe("https://issuer.example.test/");
    expect(plan.verifyOidc).toEqual({
      issuer: "https://issuer.example.test/",
      clientId: "client-1",
      clientSecret: "secret-1",
      lxdClientId: "client-1",
      lxdClientSecret: "secret-1",
      manageDomain: "primary-manage.example.test",
      proxyDomain: "primary-proxy.example.test",
      lxdDomain: "primary-lxd.example.test"
    });
  });

  test("verifies external domain changes with the configured LXD OIDC client", () => {
    const source = readFileSync(join(import.meta.dir, "config.ts"), "utf8");

    expect(source).toContain('lxdClientId: configString(config, "terrarium_lxd_oidc_client_id") || configString(config, "terrarium_oidc_client_id")');
    expect(source).toContain('setConfigValue(config, "terrarium_oidc_issuer", verification.issuer)');
  });

  test("persists a separate external LXD OIDC client without requiring a secret", () => {
    const config: Record<string, unknown> = {
      terrarium_public_ip: "203.0.113.10",
      terrarium_root_domain: "example.test",
      terrarium_manage_domain: "primary-manage.example.test",
      terrarium_proxy_domain: "primary-proxy.example.test",
      terrarium_lxd_domain: "primary-lxd.example.test",
      terrarium_auth_domain: "primary-auth.example.test",
      terrarium_admin_group: "terrarium-admins"
    };

    const plan = applySetIdpConfig(config, {
      mode: "oidc",
      oidc: "https://issuer.example.test/",
      oidcClient: "manage-client",
      oidcSecret: "manage-secret",
      lxdOidcClient: "lxd-client"
    });

    expect(config.terrarium_lxd_oidc_client_id).toBe("lxd-client");
    expect(config.terrarium_lxd_oidc_client_secret).toBe("");
    expect(plan.verifyOidc).toMatchObject({
      clientId: "manage-client",
      clientSecret: "manage-secret",
      lxdClientId: "lxd-client",
      lxdClientSecret: "",
      proxyDomain: "primary-proxy.example.test"
    });
  });

  test("reuses the preserved local auth domain when switching back to local IDP", () => {
    const config: Record<string, unknown> = {
      terrarium_public_ip: "203.0.113.10",
      terrarium_root_domain: "example.test",
      terrarium_email: "admin@example.test",
      terrarium_manage_domain: "primary-manage.example.test",
      terrarium_proxy_domain: "primary-proxy.example.test",
      terrarium_lxd_domain: "primary-lxd.example.test",
      terrarium_auth_domain: "primary-auth.example.test",
      terrarium_admin_group: "terrarium-admins",
      terrarium_oidc_issuer: "https://issuer.example.test/",
      terrarium_oidc_client_id: "client-1",
      terrarium_oidc_client_secret: "secret-1",
      terrarium_lxd_oidc_client_id: "lxd-client",
      terrarium_lxd_oidc_client_secret: "lxd-secret"
    };

    const plan = applySetIdpConfig(config, { mode: "local" });

    expect(plan.verifyOidc).toBeUndefined();
    expect(config.terrarium_auth_domain).toBe("primary-auth.example.test");
    expect(config.terrarium_oidc_issuer).toBe("https://primary-auth.example.test");
    expect(config.terrarium_oidc_client_id).toBe("");
    expect(config.terrarium_oidc_client_secret).toBe("");
    expect(config.terrarium_lxd_oidc_client_id).toBe("");
    expect(config.terrarium_lxd_oidc_client_secret).toBe("");
  });

  test("uses ZITADEL discovery issuer shape for local IDP config changes", () => {
    const source = readFileSync(join(import.meta.dir, "config.ts"), "utf8");

    expect(source).toContain('normalizeOidcIssuer(`https://${authDomain}`, "--oidc")');
    expect(source).not.toContain('normalizeOidcIssuer(`https://${authDomain}/`, "--oidc")');
  });

  test("reads set command secrets from files without requiring inline values", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-test-"));
    try {
      const oidcSecretPath = join(tempDir, "oidc-secret");
      const lxdOidcSecretPath = join(tempDir, "lxd-oidc-secret");
      const s3SecretPath = join(tempDir, "s3-secret");
      writeFileSync(oidcSecretPath, "oidc-secret-from-file\n", "utf8");
      writeFileSync(lxdOidcSecretPath, "lxd-oidc-secret-from-file\n", "utf8");
      writeFileSync(s3SecretPath, "s3-secret-from-file\n", "utf8");

      const parsed = parseSetCommandOptions({
        oidcSecretFile: oidcSecretPath,
        lxdOidcSecretFile: lxdOidcSecretPath,
        "s3-secretKeyFile": s3SecretPath
      });

      expect(parsed.idp.oidcSecret).toBe("oidc-secret-from-file");
      expect(parsed.idp.lxdOidcSecret).toBe("lxd-oidc-secret-from-file");
      expect(parsed.s3.s3SecretKey).toBe("s3-secret-from-file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("leaves omitted set command secrets undefined", () => {
    const parsed = parseSetCommandOptions({});

    expect(parsed.idp.oidcSecret).toBeUndefined();
    expect(parsed.idp.lxdOidcSecret).toBeUndefined();
    expect(parsed.s3.s3SecretKey).toBeUndefined();
  });

  test("stores DNS provider credentials as exact lego environment variables", () => {
    const config: Record<string, unknown> = {};

    const summary = applySetDnsProviderConfig(config, {
      provider: "Cloudflare",
      credentials: ["CF_API_KEY:key:with:colon", "CF_DNS_API_TOKEN:token"]
    });

    expect(summary).toBe("Enabled DNS-01 ACME provider cloudflare");
    expect(config.terrarium_acme_dns_provider).toBe("cloudflare");
    expect(config.terrarium_acme_dns_env).toEqual({
      CF_API_KEY: "key:with:colon",
      CF_DNS_API_TOKEN: "token"
    });
  });

  test("clears DNS provider and DNS credentials together", () => {
    const config: Record<string, unknown> = {
      terrarium_acme_dns_provider: "cloudflare",
      terrarium_acme_dns_env: { CF_DNS_API_TOKEN: "token" }
    };

    const summary = applySetDnsProviderConfig(config, { provider: undefined, credentials: [] });

    expect(summary).toBe("Disabled DNS-01 ACME");
    expect(config.terrarium_acme_dns_provider).toBe("");
    expect(config.terrarium_acme_dns_env).toEqual({});
  });

  test("rejects DNS credentials that are not environment variable assignments", () => {
    expect(() =>
      applySetDnsProviderConfig(
        {},
        {
          provider: "cloudflare",
          credentials: ["cf-token:secret"]
        }
      )
    ).toThrow("uppercase lego environment variable");
  });
});
