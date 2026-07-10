import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetDnsProviderConfig, applySetIdpConfig, parseSetCommandOptions, runReconcileActions, type ReconcileActions } from "./config";
import { localIdpOutputsPath, lxdOidcGroupsClaim, lxdOidcScopes, oidcGroupsClaim, oidcScopes } from "./context";
import { DEFAULT_LOCAL_IDP_OUTPUTS_PATH } from "../lib/idp-provider";

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

  test("wires provider set idp flags through terrariumctl source", () => {
    const ctlSource = readFileSync(join(import.meta.dir, "..", "terrariumctl.ts"), "utf8");
    const configSource = readFileSync(join(import.meta.dir, "config.ts"), "utf8");

    expect(ctlSource).toContain('.option("--provider <provider>"');
    expect(ctlSource).toContain('.option("--idp-provider <provider>"');
    expect(configSource).toContain('provider: cliOption(rawOptions, "provider", ["idpProvider", "idp-provider"])');
  });

  test("parses provider and claim/scope set idp flags", () => {
    const parsed = parseSetCommandOptions({
      "idp-provider": "logto",
      "oidc-groups-claim": "roles",
      "oidc-scopes": "openid profile email roles",
      "lxd-oidc-groups-claim": "organization_roles",
      "lxd-oidc-scopes": "openid email organizations",
      "local-idp-outputs-path": "/run/terrarium/idp-apps.json"
    });

    expect(parsed.idp.provider).toBe("logto");
    expect(parsed.idp.oidcGroupsClaim).toBe("roles");
    expect(parsed.idp.oidcScopes).toBe("openid profile email roles");
    expect(parsed.idp.lxdOidcGroupsClaim).toBe("organization_roles");
    expect(parsed.idp.lxdOidcScopes).toBe("openid email organizations");
    expect(parsed.idp.localIdpOutputsPath).toBe("/run/terrarium/idp-apps.json");
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

  test("persists an explicit public IDP provider", () => {
    const config: Record<string, unknown> = {};

    applySetIdpConfig(config, {
      mode: "oidc",
      provider: "logto",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(config.terrarium_idp_provider).toBe("logto");
  });

  test("does not persist an IDP provider when omitted", () => {
    const config: Record<string, unknown> = {};

    applySetIdpConfig(config, {
      mode: "oidc",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(config).not.toHaveProperty("terrarium_idp_provider");
  });

  test("rejects invalid explicit IDP providers including generic", () => {
    expect(() => applySetIdpConfig({}, { mode: "oidc", provider: "generic" })).toThrow("expected one of: zitadel, logto");
    expect(() => applySetIdpConfig({}, { mode: "oidc", provider: "custom" })).toThrow("expected one of: zitadel, logto");
  });

  test("uses Logto claim and scope defaults through context helpers", () => {
    const config: Record<string, unknown> = {};

    applySetIdpConfig(config, {
      mode: "oidc",
      provider: "logto",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(oidcGroupsClaim(config)).toBe("roles");
    expect(oidcScopes(config)).toBe("openid profile email roles");
    expect(lxdOidcGroupsClaim(config)).toBe("roles");
    expect(lxdOidcScopes(config)).toBe("openid profile email roles");
  });

  test("uses ZITADEL-compatible claim and scope defaults when provider is omitted or explicit", () => {
    const omittedProviderConfig: Record<string, unknown> = {};
    const explicitZitadelConfig: Record<string, unknown> = {};

    applySetIdpConfig(omittedProviderConfig, {
      mode: "oidc",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });
    applySetIdpConfig(explicitZitadelConfig, {
      mode: "oidc",
      provider: "zitadel",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1"
    });

    expect(oidcGroupsClaim(omittedProviderConfig)).toBe("groups");
    expect(oidcScopes(omittedProviderConfig)).toBe("openid profile email");
    expect(oidcGroupsClaim(explicitZitadelConfig)).toBe("groups");
    expect(oidcScopes(explicitZitadelConfig)).toBe("openid profile email");
  });

  test("persists IDP claim and scope overrides exactly and resolves them first", () => {
    const config: Record<string, unknown> = {};

    applySetIdpConfig(config, {
      mode: "oidc",
      provider: "logto",
      adminGroup: "admins",
      oidc: "https://issuer.example.test/",
      oidcClient: "client-1",
      oidcSecret: "secret-1",
      oidcGroupsClaim: " custom_groups ",
      oidcScopes: "openid custom",
      lxdOidcGroupsClaim: "lxd_groups",
      lxdOidcScopes: "openid lxd"
    });

    expect(config.terrarium_oidc_groups_claim).toBe(" custom_groups ");
    expect(config.terrarium_oidc_scopes).toBe("openid custom");
    expect(config.terrarium_lxd_oidc_groups_claim).toBe("lxd_groups");
    expect(config.terrarium_lxd_oidc_scopes).toBe("openid lxd");
    expect(oidcGroupsClaim(config)).toBe("custom_groups");
    expect(oidcScopes(config)).toBe("openid custom");
    expect(lxdOidcGroupsClaim(config)).toBe("lxd_groups");
    expect(lxdOidcScopes(config)).toBe("openid lxd");
  });

  test("skips ZITADEL output stabilization for local Logto provider", async () => {
    const calls: string[] = [];

    await runReconcileActions({ terrarium_idp_mode: "local", terrarium_idp_provider: "logto" }, recordActions(calls, ["old", "new"]));

    expect(calls).toEqual(["reconfigure", "syncProxy"]);
  });

  test("resolves local IDP output path precedence", () => {
    expect(
      localIdpOutputsPath({
        terrarium_local_idp_outputs_path: "/canonical/idp-apps.json",
        terrarium_zitadel_outputs_path: "/legacy/zitadel-apps.json"
      })
    ).toBe("/canonical/idp-apps.json");
    expect(localIdpOutputsPath({ terrarium_zitadel_outputs_path: "/legacy/zitadel-apps.json" })).toBe("/legacy/zitadel-apps.json");
    expect(localIdpOutputsPath({})).toBe(DEFAULT_LOCAL_IDP_OUTPUTS_PATH);
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
