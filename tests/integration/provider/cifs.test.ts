import { describe, expect, test } from "bun:test";
import type { IntegrationConfig } from "../types";
import { IntegrationLogger } from "../lib/logger";
import { CifsProvider } from "./cifs";

function provider(cifsHostPathBase: string): CifsProvider {
  return new CifsProvider(
    {
      cifsAddress: "//example/share",
      cifsUsername: "user",
      cifsPassword: "password",
      cifsHostPathBase
    } as IntegrationConfig,
    new IntegrationLogger("test")
  );
}

describe("CIFS provider", () => {
  test("uses the mount root directly when host path base is the share root", () => {
    expect(provider("/").runPath("local-test")).toBe("");
  });

  test("normalizes nested host path bases", () => {
    expect(provider("/fixtures/shared/").runPath("local-test")).toBe("fixtures/shared/local-test");
  });
});
