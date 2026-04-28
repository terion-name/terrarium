import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("hardening role", () => {
  test("can be skipped for day-2 configuration reconciliation", () => {
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    expect(site).toContain("terrarium_apply_hardening: true");
    expect(site).toContain("role: hardening");
    expect(site).toContain("when: terrarium_apply_hardening | bool");
  });

  test("set commands reconfigure without rerunning hardening", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const system = readFileSync(join(repoRoot, "scripts/ctl/system.ts"), "utf8");
    expect(ctl).toContain("reconfigure: () => reconfigureCmd({ applyHardening: false })");
    expect(system).toContain("terrarium_apply_hardening=false");
  });
});
