import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("terrarium update command", () => {
  test("updates release bundle installs without rerunning the install wizard", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const update = readFileSync(join(repoRoot, "scripts/ctl/update.ts"), "utf8");

    expect(ctl).toContain('.command("update"');
    expect(ctl).toContain('option("--ref <ref>"');
    expect(ctl).toContain('option("--skip-reconfigure"');
    expect(ctl).toContain('option("--non-interactive"');
    expect(update).toContain("TERRARIUM_BUNDLE_DIR");
    expect(update).toContain("syncTree(BUNDLE_DIR, REPO_DIR)");
    expect(update).toContain('"git", "ansible", "python3", "jq", "unzip"');
    expect(update).toContain("refusing to sync Terrarium source onto itself");
    expect(update).toContain('existsSync("/opt/bun/bin/bun") ? "/opt/bun/bin/bun" : "bun"');
    expect(update).toContain("installAnsibleCollections");
    expect(update).toContain("reconfigureCmd({ applyHardening: false })");
    expect(update).toContain("installCompiledCli");
    expect(update).toContain('"completion", "all", "install"');
    expect(update).not.toContain("interactiveConfig");
    expect(update).not.toContain("confirmDestructiveActions");
  });
});
