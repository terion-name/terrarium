import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("base role packages", () => {
  test("installs CIFS userspace and the matching kernel module package", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/base/defaults/main.yml"), "utf8");

    expect(defaults).toContain("- cifs-utils");
    expect(defaults).toContain('- "linux-modules-extra-{{ ansible_kernel }}"');
  });
});

describe("terrariumctl mount defaults", () => {
  test("disable client-side CIFS permission checks for single-credential managed mounts", () => {
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(mount).toContain('"noperm"');
    expect(mount).toContain('"forceuid"');
    expect(mount).toContain('"forcegid"');
  });

  test("supports file-based CIFS password input", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(ctl).toContain("--password-file <path>");
    expect(mount).toContain("passwordFile?: string");
    expect(mount).toContain("readFileSync(options.passwordFile");
  });
});
