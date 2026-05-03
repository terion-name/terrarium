import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCP_ATTEMPTS,
  DEFAULT_SCP_COMMAND_TIMEOUT_MS,
  DEFAULT_SSH_COMMAND_TIMEOUT_MS,
  remoteTarRootPattern,
  sshCommandTimeoutMs
} from "./ssh";

describe("SSH archive helpers", () => {
  test("converts archive paths and globs into tar includes relative to root", () => {
    expect(remoteTarRootPattern("/etc/terrarium")).toBe("etc/terrarium");
    expect(remoteTarRootPattern("/etc/systemd/system/terrarium*")).toBe("etc/systemd/system/terrarium*");
    expect(remoteTarRootPattern("var/log")).toBe("var/log");
    expect(remoteTarRootPattern("//var/lib/terrarium")).toBe("var/lib/terrarium");
    expect(remoteTarRootPattern("/")).toBe(".");
  });

  test("applies a local timeout to SSH commands by default", () => {
    expect(sshCommandTimeoutMs()).toBe(DEFAULT_SSH_COMMAND_TIMEOUT_MS);
    expect(sshCommandTimeoutMs({ timeoutMs: 1234 })).toBe(1234);
  });

  test("bounds stalled SCP attempts below the full remote command timeout", () => {
    expect(DEFAULT_SCP_ATTEMPTS).toBeGreaterThan(1);
    expect(DEFAULT_SCP_COMMAND_TIMEOUT_MS).toBeLessThan(DEFAULT_SSH_COMMAND_TIMEOUT_MS);
  });
});
