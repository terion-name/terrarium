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
  test("reads the Logto admin from config and the dedicated Logto secret", async () => {
    const ssh = fakeSshHost([
      {
        exitCode: 0,
        stdout:
          "terrarium_email: owner@example.test\nterrarium_logto_admin_email: admin@example.test\nterrarium_logto_instance_name: custom-logto\n",
        stderr: ""
      },
      {
        exitCode: 0,
        stdout: "logto-secret\n",
        stderr: ""
      }
    ]);

    await expect(readLocalAdmin(testContext("logto"), ssh)).resolves.toEqual({
      email: "admin@example.test",
      password: "logto-secret"
    });
    expect(ssh.commands).toHaveLength(2);
    expect(ssh.commands[0]).toContain("terrariumctl config export");
    expect(ssh.commands[1]).toContain("lxc info 'custom-logto'");
    expect(ssh.commands[1]).toContain("logto_admin_password");
    expect(ssh.commands[1]).not.toContain("zitadel_admin_password");
  });

  test("falls back to the Terrarium email for Logto admin credentials", async () => {
    const ssh = fakeSshHost([
      {
        exitCode: 0,
        stdout: "terrarium_email: owner@example.test\n",
        stderr: ""
      },
      {
        exitCode: 0,
        stdout: "logto-secret\n",
        stderr: ""
      }
    ]);

    await expect(readLocalAdmin(testContext("logto"), ssh)).resolves.toEqual({
      email: "owner@example.test",
      password: "logto-secret"
    });
    expect(ssh.commands[1]).toContain("lxc info 'terrarium-idp'");
  });

  test("falls back to the integration base email for Logto admin credentials", async () => {
    const ssh = fakeSshHost([
      {
        exitCode: 0,
        stdout: "terrarium_logto_instance_name: terrarium-idp\n",
        stderr: ""
      },
      {
        exitCode: 0,
        stdout: "logto-secret\n",
        stderr: ""
      }
    ]);

    await expect(readLocalAdmin(testContext("logto"), ssh)).resolves.toEqual({
      email: "terrarium+local-test@example.test",
      password: "logto-secret"
    });
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
