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

  test("preserves provider-injected SSH key revocation after sshd hardening", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/hardening/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/hardening/tasks/main.yml"), "utf8");

    expect(defaults).toContain('terrarium_hardening_ssh_permit_root_login: "prohibit-password"');
    expect(defaults).toContain('terrarium_hardening_ssh_authorized_keys_file: ".ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/authorized_keys/%u"');
    expect(tasks).toContain("path: /etc/ssh/authorized_keys/root");
    expect(tasks).toContain("Enforce provider-managed root SSH key permissions");
    expect(tasks).toContain("Read provider-managed root SSH authorized keys");
    expect(tasks).toContain("Remove provider-managed root SSH keys from OpenSSH default location");
    expect(tasks).toContain("state: absent");
    expect(tasks).toContain("ssh_authorized_keys_file: \"{{ terrarium_hardening_ssh_authorized_keys_file }}\"");
    expect(tasks).not.toContain("Preserve provider-managed root SSH keys in OpenSSH default location");
    expect(tasks).not.toContain("source=/etc/ssh/authorized_keys/root");
    expect(tasks).not.toContain("target=/root/.ssh/authorized_keys");
  });
});
