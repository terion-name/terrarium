import { describe, expect, test } from "bun:test";
import { idpBackupCmd, idpLogsCmd, idpRestoreCmd, idpStatusCmd } from "./idp";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

const unmanagedRuntimeMessage = "Terrarium does not manage a local IDP runtime for this IDP mode/provider.";

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function ok(stdout = "active\n"): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("terrariumctl idp runtime commands", () => {
  test("checks the default local ZITADEL instance and compose project", async () => {
    const commands: string[][] = [];
    const logs: string[] = [];
    const outputs = [ok("Name: terrarium-idp\n"), ok("zitadel service row\n")];

    await idpStatusCmd({
      config: { terrarium_idp_mode: "local" },
      runAllowFailure: async (cmd) => {
        commands.push(cmd);
        return outputs.shift() ?? ok();
      },
      log: (message) => logs.push(stripAnsi(message))
    });

    expect(commands).toEqual([
      ["lxc", "info", "terrarium-idp"],
      [
        "lxc",
        "exec",
        "terrarium-idp",
        "--",
        "docker",
        "compose",
        "--project-name",
        "terrarium-zitadel",
        "-f",
        "/var/lib/terrarium/zitadel/docker-compose.yml",
        "ps"
      ]
    ]);
    expect(logs.join("\n")).toContain("ZITADEL system instance");
    expect(logs.join("\n")).toContain("ZITADEL compose services");
  });

  test("uses custom local ZITADEL metadata for logs", async () => {
    const commands: string[][] = [];
    const logs: string[] = [];

    await idpLogsCmd("42", {
      config: { terrarium_idp_mode: "local", terrarium_zitadel_instance_name: "custom-zitadel" },
      runText: async (cmd) => {
        commands.push(cmd);
        return "log line\n";
      },
      log: (message) => logs.push(message)
    });

    expect(commands).toEqual([
      [
        "lxc",
        "exec",
        "custom-zitadel",
        "--",
        "docker",
        "compose",
        "--project-name",
        "terrarium-zitadel",
        "-f",
        "/var/lib/terrarium/zitadel/docker-compose.yml",
        "logs",
        "--tail",
        "42"
      ]
    ]);
    expect(logs).toEqual(["log line"]);
  });

  test("backs up and restores the configured local ZITADEL instance", async () => {
    const runTextCommands: string[][] = [];
    const restoreCalls: unknown[] = [];

    await idpBackupCmd({
      config: {
        terrarium_idp_mode: "local",
        terrarium_lxd_pool_name: "tank",
        terrarium_zitadel_instance_name: "custom-zitadel"
      },
      now: () => new Date("2026-07-07T01:02:03.000Z"),
      runText: async (cmd) => {
        runTextCommands.push(cmd);
        return "";
      },
      log: () => {}
    });
    await idpRestoreCmd(
      { source: "local", at: "manual", asNew: "restored-zitadel" },
      {
        config: { terrarium_idp_mode: "local", terrarium_zitadel_instance_name: "custom-zitadel" },
        backupAction: async (action, options) => {
          restoreCalls.push({ action, options });
        }
      }
    );

    expect(runTextCommands).toEqual([
      ["zfs", "snapshot", "-r", "tank/containers/custom-zitadel@idp-manual-20260707T010203Z"]
    ]);
    expect(restoreCalls).toEqual([
      {
        action: "restore",
        options: { source: "local", instance: "custom-zitadel", at: "manual", asNew: "restored-zitadel" }
      }
    ]);
  });

  test("uses local Logto compose, service, backup, and restore metadata", async () => {
    const statusCommands: string[][] = [];
    const logCommands: string[][] = [];
    const backupCommands: string[][] = [];
    const restoreCalls: unknown[] = [];
    const statusLogs: string[] = [];
    const config = {
      terrarium_idp_mode: "local",
      terrarium_idp_provider: "logto",
      terrarium_logto_instance_name: "custom-logto",
      terrarium_lxd_pool_name: "tank"
    };

    await idpStatusCmd({
      config,
      runAllowFailure: async (cmd) => {
        statusCommands.push(cmd);
        return ok(cmd.includes("ps") ? "logto service row\n" : "Name: custom-logto\n");
      },
      log: (message) => statusLogs.push(stripAnsi(message))
    });
    await idpLogsCmd("7", {
      config,
      runText: async (cmd) => {
        logCommands.push(cmd);
        return "logto log\n";
      },
      log: () => {}
    });
    await idpBackupCmd({
      config,
      now: () => new Date("2026-07-07T01:02:03.000Z"),
      runText: async (cmd) => {
        backupCommands.push(cmd);
        return "";
      },
      log: () => {}
    });
    await idpRestoreCmd(
      { source: "s3", at: "latest" },
      {
        config,
        backupAction: async (action, options) => {
          restoreCalls.push({ action, options });
        }
      }
    );

    expect(statusLogs.join("\n")).toContain("Logto system instance");
    expect(statusLogs.join("\n")).toContain("Logto compose services");
    expect(statusCommands).toEqual([
      ["lxc", "info", "custom-logto"],
      [
        "lxc",
        "exec",
        "custom-logto",
        "--",
        "docker",
        "compose",
        "--project-name",
        "terrarium-logto",
        "-f",
        "/var/lib/terrarium/logto/docker-compose.yml",
        "ps"
      ]
    ]);
    expect(logCommands).toEqual([
      [
        "lxc",
        "exec",
        "custom-logto",
        "--",
        "docker",
        "compose",
        "--project-name",
        "terrarium-logto",
        "-f",
        "/var/lib/terrarium/logto/docker-compose.yml",
        "logs",
        "--tail",
        "7"
      ]
    ]);
    expect(backupCommands).toEqual([
      ["zfs", "snapshot", "-r", "tank/containers/custom-logto@idp-manual-20260707T010203Z"]
    ]);
    expect(restoreCalls).toEqual([{ action: "restore", options: { source: "s3", instance: "custom-logto", at: "latest" } }]);
  });

  test("does not probe LXC and fails stateful actions for unmanaged external IDP runtimes", async () => {
    const logs: string[] = [];
    const failIfCalled = async (cmd: string[]): Promise<CommandResult> => {
      throw new Error(`unexpected command: ${cmd.join(" ")}`);
    };
    const failRunTextIfCalled = async (cmd: string[]): Promise<string> => {
      throw new Error(`unexpected command: ${cmd.join(" ")}`);
    };
    const config = { terrarium_idp_mode: "oidc" };

    await idpStatusCmd({ config, runAllowFailure: failIfCalled, log: (message) => logs.push(message) });
    await idpLogsCmd("10", { config, runText: failRunTextIfCalled, log: (message) => logs.push(message) });

    expect(logs).toEqual([unmanagedRuntimeMessage, unmanagedRuntimeMessage]);
    await expect(idpBackupCmd({ config, runText: failRunTextIfCalled, log: () => {} })).rejects.toThrow(unmanagedRuntimeMessage);
    await expect(
      idpRestoreCmd(
        { source: "local" },
        {
          config,
          backupAction: async () => {
            throw new Error("unexpected restore");
          }
        }
      )
    ).rejects.toThrow(unmanagedRuntimeMessage);
  });
});
