import { describe, expect, test } from "bun:test";
import { cac } from "cac";
import { partitionEndForCandidate, readCliOption, registerInstallCommand } from "./terrarium-install";

describe("terrarium install CLI parsing", () => {
  test("recovers exact numeric-looking OIDC client IDs from argv when cac coerces them", () => {
    const cli = cac("terrariumctl");
    const managementClientId = "370342054720506035";
    const lxdClientId = "370342055777410480";
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "terrariumctl",
      "install",
      "--oidc-client",
      managementClientId,
      "--lxd-oidc-client",
      lxdClientId
    ];

    try {
      registerInstallCommand(cli);
      const parsed = cli.parse(process.argv, { run: false });

      expect(readCliOption(parsed.options, "oidcClient", ["oidc-client"])).toBe(managementClientId);
      expect(readCliOption(parsed.options, "lxdOidcClient", ["lxd-oidc-client"])).toBe(lxdClientId);
    } finally {
      process.argv = originalArgv;
    }
  });

  test("caps auto free-space partition end using explicit storage size", () => {
    expect(
      partitionEndForCandidate(
        {
          kind: "free-space",
          source: "/dev/sdb",
          sizeBytes: 38 * 1024 * 1024 * 1024,
          sizeLabel: "38G",
          description: "/dev/sdb free space",
          startMiB: "2048MiB",
          endMiB: "40960MiB"
        },
        "32G"
      )
    ).toBe("34816MiB");
  });
});
