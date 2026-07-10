import { describe, expect, test } from "bun:test";
import { localAuthDiscoveryUrl, readLocalAdmin } from "./common";
import type { IntegrationContext } from "../context";
import type { SshExecResult, SshHost } from "../remote/ssh";

function testContext(idpProvider: "zitadel" | "logto"): IntegrationContext {
  return {
    config: {
      idpProvider,
      slug: "local-test",
      ipDnsDomain: "example.test"
    }
  } as unknown as IntegrationContext;
}

function fakeSshHost(results: SshExecResult[]): SshHost & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async execAllowFailure(command: string): Promise<SshExecResult> {
      commands.push(command);
      const result = results.shift();
      if (!result) {
        throw new Error(`unexpected SSH command: ${command}`);
      }
      return result;
    }
  } as SshHost & { commands: string[] };
}

describe("integration public endpoint readiness", () => {
  test("uses Logto's local OIDC discovery path", () => {
    expect(localAuthDiscoveryUrl("auth.example.test", "logto")).toBe(
      "https://auth.example.test/oidc/.well-known/openid-configuration"
    );
  });

  test("keeps ZITADEL's local OIDC discovery at the root well-known path", () => {
    expect(localAuthDiscoveryUrl("auth.example.test", "zitadel")).toBe(
      "https://auth.example.test/.well-known/openid-configuration"
    );
  });
});

describe("integration local admin credentials", () => {
  test("returns the install-provisioned Logto admin without reading ZITADEL files", async () => {
    const ssh = fakeSshHost([]);

    await expect(readLocalAdmin(testContext("logto"), ssh)).resolves.toEqual({
      email: "terrarium+local-test@example.test",
      password: "Terrarium!local-test"
    });
    expect(ssh.commands).toEqual([]);
  });

  test("keeps reading ZITADEL bootstrap credentials from the host", async () => {
    const ssh = fakeSshHost([
      {
        exitCode: 0,
        stdout: "terrarium_zitadel_admin_email: admin@example.test\nterrarium_zitadel_instance_name: terrarium-idp\n",
        stderr: ""
      },
      {
        exitCode: 0,
        stdout: "zitadel-secret\n",
        stderr: ""
      }
    ]);

    await expect(readLocalAdmin(testContext("zitadel"), ssh)).resolves.toEqual({
      email: "admin@example.test",
      password: "zitadel-secret"
    });
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[0]).toContain("terrariumctl config export");
    expect(ssh.commands[1]).toContain("zitadel_admin_password");
  });
});
