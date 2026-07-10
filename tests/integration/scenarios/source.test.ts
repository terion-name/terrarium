import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("integration scenario external OIDC source wiring", () => {
  test("install and reconfigure commands pass the selected external provider", () => {
    const common = source("tests/integration/scenarios/common.ts");

    expect(common).toContain("--idp-provider ${shellArg(context.config.idpProvider)}");
    expect(common).toContain("--provider ${shellArg(context.config.idpProvider)}");
    expect(common).toContain("--oidc ${shellArg(context.externalOidcIssuer)}");
    expect(common).not.toContain("context.config.zitadelCloudIssuer");
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
