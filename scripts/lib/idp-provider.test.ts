import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_IDP_OUTPUTS_PATH,
  defaultIdpProviderValues,
  normalizePublicIdpProvider,
  resolveEffectiveIdpProvider,
  resolveLocalIdpOutputsPath,
  resolveLocalOidcIssuer,
  resolveLxdOidcGroupsClaim,
  resolveLxdOidcScopes,
  resolveOidcGroupsClaim,
  resolveOidcScopes,
  validatePublicIdpProvider
} from "./idp-provider";

describe("IDP provider helpers", () => {
  test("normalize and validate public providers", () => {
    expect(normalizePublicIdpProvider(" zitadel ")).toBe("zitadel");
    expect(normalizePublicIdpProvider("LOGTO")).toBe("logto");
    expect(normalizePublicIdpProvider("generic")).toBe("");
    expect(validatePublicIdpProvider("logto")).toBe("logto");
    expect(() => validatePublicIdpProvider("generic")).toThrow("invalid IDP provider");
    expect(() => validatePublicIdpProvider("auth0")).toThrow("expected one of: zitadel, logto");
  });

  test("resolves the effective provider matrix", () => {
    expect(resolveEffectiveIdpProvider("local")).toBe("zitadel");
    expect(resolveEffectiveIdpProvider("oidc")).toBe("generic");
    expect(resolveEffectiveIdpProvider("local", "zitadel")).toBe("zitadel");
    expect(resolveEffectiveIdpProvider("oidc", "zitadel")).toBe("zitadel");
    expect(resolveEffectiveIdpProvider("local", "logto")).toBe("logto");
    expect(resolveEffectiveIdpProvider("oidc", "logto")).toBe("logto");
    expect(() => resolveEffectiveIdpProvider("oidc", "generic")).toThrow("invalid IDP provider");
  });

  test("uses provider defaults for claims and scopes", () => {
    expect(defaultIdpProviderValues("generic")).toEqual({ groupsClaim: "groups", scopes: "openid profile email" });
    expect(defaultIdpProviderValues("zitadel")).toEqual({ groupsClaim: "groups", scopes: "openid profile email" });
    expect(defaultIdpProviderValues("logto")).toEqual({ groupsClaim: "roles", scopes: "openid profile email roles" });
  });

  test("resolves generic OIDC claim and scope overrides before provider defaults", () => {
    expect(resolveOidcGroupsClaim({}, "logto")).toBe("roles");
    expect(resolveOidcScopes({}, "logto")).toBe("openid profile email roles");
    expect(resolveOidcGroupsClaim({}, "generic")).toBe("groups");
    expect(resolveOidcScopes({}, "zitadel")).toBe("openid profile email");

    const config = {
      terrarium_oidc_groups_claim: " teams ",
      terrarium_oidc_scopes: "openid email teams"
    };
    expect(resolveOidcGroupsClaim(config, "logto")).toBe("teams");
    expect(resolveOidcScopes(config, "logto")).toBe("openid email teams");
  });

  test("resolves LXD claim and scope overrides before provider defaults", () => {
    expect(resolveLxdOidcGroupsClaim({}, "logto")).toBe("roles");
    expect(resolveLxdOidcScopes({}, "logto")).toBe("openid profile email roles");
    expect(resolveLxdOidcGroupsClaim({}, "generic")).toBe("groups");
    expect(resolveLxdOidcScopes({}, "zitadel")).toBe("openid profile email");

    const config = {
      terrarium_lxd_oidc_groups_claim: " lxd_groups ",
      terrarium_lxd_oidc_scopes: "openid profile lxd"
    };
    expect(resolveLxdOidcGroupsClaim(config, "logto")).toBe("lxd_groups");
    expect(resolveLxdOidcScopes(config, "logto")).toBe("openid profile lxd");
  });

  test("resolves local issuer URL per provider", () => {
    expect(resolveLocalOidcIssuer("auth.example.test", "zitadel")).toBe("https://auth.example.test");
    expect(resolveLocalOidcIssuer("auth.example.test", "generic")).toBe("https://auth.example.test");
    expect(resolveLocalOidcIssuer("auth.example.test", "logto")).toBe("https://auth.example.test/oidc");
    expect(resolveLocalOidcIssuer(" auth.example.test/ ", "logto")).toBe("https://auth.example.test/oidc");
  });

  test("resolves local IDP outputs path with canonical, fallback, then default precedence", () => {
    expect(resolveLocalIdpOutputsPath({})).toBe(DEFAULT_LOCAL_IDP_OUTPUTS_PATH);
    expect(resolveLocalIdpOutputsPath({ terrarium_zitadel_outputs_path: "/compat/zitadel.json" })).toBe("/compat/zitadel.json");
    expect(
      resolveLocalIdpOutputsPath({
        terrarium_local_idp_outputs_path: " /canonical/idp.json ",
        terrarium_zitadel_outputs_path: "/compat/zitadel.json"
      })
    ).toBe("/canonical/idp.json");
    expect(
      resolveLocalIdpOutputsPath({
        terrarium_local_idp_outputs_path: " ",
        terrarium_zitadel_outputs_path: " /compat/zitadel.json "
      })
    ).toBe("/compat/zitadel.json");
  });
});
