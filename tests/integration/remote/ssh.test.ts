import { describe, expect, test } from "bun:test";
import { remoteTarRootPattern } from "./ssh";

describe("SSH archive helpers", () => {
  test("converts archive paths and globs into tar includes relative to root", () => {
    expect(remoteTarRootPattern("/etc/terrarium")).toBe("etc/terrarium");
    expect(remoteTarRootPattern("/etc/systemd/system/terrarium*")).toBe("etc/systemd/system/terrarium*");
    expect(remoteTarRootPattern("var/log")).toBe("var/log");
    expect(remoteTarRootPattern("//var/lib/terrarium")).toBe("var/lib/terrarium");
    expect(remoteTarRootPattern("/")).toBe(".");
  });
});
