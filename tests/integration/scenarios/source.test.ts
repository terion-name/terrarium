import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("integration scenario IDP source wiring", () => {
  test("local install commands pass the selected provider before IDP mode branching", () => {
    const common = source("tests/integration/scenarios/common.ts");

    const idpModeArg = common.indexOf("`--idp ${options.idpMode}`");
    const idpProviderArg = common.indexOf("`--idp-provider ${shellArg(context.config.idpProvider)}`");
    const localBranch = common.indexOf('if (options.idpMode === "local")');
    expect(idpModeArg).toBeGreaterThanOrEqual(0);
    expect(idpProviderArg).toBeGreaterThan(idpModeArg);
    expect(idpProviderArg).toBeLessThan(localBranch);
    expect(common.match(/--idp-provider \$\{shellArg\(context\.config\.idpProvider\)\}/g)).toHaveLength(1);
  });

  test("reconfigure commands pass the selected external provider", () => {
    const common = source("tests/integration/scenarios/common.ts");

    expect(common).toContain("--provider ${shellArg(context.config.idpProvider)}");
    expect(common).toContain("--oidc ${shellArg(context.externalOidcIssuer)}");
    expect(common).not.toContain("context.config.zitadelCloudIssuer");
  });

  test("public endpoint readiness uses provider-specific local auth discovery", () => {
    const common = source("tests/integration/scenarios/common.ts");
    const smoke = source("tests/integration/scenarios/smoke.ts");

    expect(common).toContain("localAuthDiscoveryUrl(host.domains.auth, localIdpProvider)");
    expect(common).toContain('provider === "logto" ? "/oidc/.well-known/openid-configuration"');
    expect(common).toContain(': "/.well-known/openid-configuration"');
    expect(smoke).toContain("waitForTerrariumPublicEndpoints(primary, true, context.config.idpProvider)");
  });

  test("smoke scenario uses provider-aware local admin credentials", () => {
    const smoke = source("tests/integration/scenarios/smoke.ts");

    expect(smoke).toContain("readLocalAdmin(context, primarySsh)");
    expect(smoke).not.toContain("readLocalZitadelAdmin(primarySsh)");
  });

  test("smoke and full scenarios use provider-neutral fixture provisioning and issuer helpers", () => {
    const smoke = source("tests/integration/scenarios/smoke.ts");
    const full = source("tests/integration/scenarios/full.ts");

    for (const scenarioSource of [smoke, full]) {
      expect(scenarioSource).toContain("provisionExternalOidcFixture");
      expect(scenarioSource).not.toContain("provisionZitadelFixture");
      expect(scenarioSource).not.toContain("context.config.zitadelCloudIssuer");
    }
    expect(full).toContain("--provider ${shellArg(context.config.idpProvider)}");
    expect(full).toContain("context.externalOidcIssuer");
  });
});
