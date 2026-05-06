import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCAL_PROCESS_ATTEMPTS, isRetryableLocalProcessFailure, run, runAllowFailure } from "./process";

describe("integration process helpers", () => {
  test("renders stdout and stderr for failed commands", async () => {
    await expect(run(["bash", "-lc", "echo useful-stdout; echo useful-stderr >&2; exit 7"])).rejects.toThrow(
      /command failed \(7\): bash -lc.*stdout:\nuseful-stdout.*stderr:\nuseful-stderr/s
    );
  });

  test("retries only local EBADF subprocess failures", () => {
    expect(DEFAULT_LOCAL_PROCESS_ATTEMPTS).toBeGreaterThan(1);
    expect(isRetryableLocalProcessFailure({ exitCode: 127, stdout: "", stderr: "EBADF: bad file descriptor, epoll_ctl" })).toBeTrue();
    expect(isRetryableLocalProcessFailure({ exitCode: 127, stdout: "", stderr: "bash: missing-command: command not found" })).toBeFalse();
    expect(isRetryableLocalProcessFailure({ exitCode: 124, stdout: "", stderr: "EBADF: bad file descriptor, epoll_ctl" })).toBeFalse();
  });

  test("terminates timed-out commands before resolving", async () => {
    const startedAt = Date.now();
    const result = await runAllowFailure(["bash", "-lc", "trap '' TERM; sleep 10"], { timeoutMs: 100 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("command timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  test("terminates timed-out process groups with inherited pipes", async () => {
    const startedAt = Date.now();
    const result = await runAllowFailure(["bash", "-lc", "sleep 10 & exit 0"], { timeoutMs: 100 });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("command timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});
