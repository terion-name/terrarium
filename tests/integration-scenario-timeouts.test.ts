import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("integration scenario timeout guardrails", () => {
  const commonSource = readFileSync(new URL("./integration/scenarios/common.ts", import.meta.url), "utf8");

  test("logs and bounds LXD API verification after identity-provider switches", () => {
    expect(commonSource).toContain("verify ${host.label} LXD API");
    expect(commonSource).toContain("verified ${host.label} LXD API");
    expect(commonSource).toContain("external OIDC LXD API for ${host.label}");
    expect(commonSource).toContain("local ZITADEL LXD API for ${host.label}");
    expect(commonSource.match(/verifyLxdApi\(host, context\)/g)?.length).toBe(2);
  });
});
