import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("LXD profiles", () => {
  test("makes the Docker-friendly Terrarium profile the LXD default", () => {
    const preseed = readRepoFile("ansible/roles/lxd/templates/lxd-preseed.yml.j2");
    const defaultProfile = readRepoFile("ansible/roles/lxd/templates/default-profile.yml.j2");
    const terrariumProfile = readRepoFile("ansible/roles/lxd/templates/terrarium-profile.yml.j2");
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");

    for (const content of [preseed, defaultProfile, terrariumProfile]) {
      expect(content).toContain('security.idmap.isolated: "true"');
      expect(content).toContain('security.nesting: "true"');
      expect(content).toContain('security.syscalls.intercept.mknod: "true"');
      expect(content).toContain('security.syscalls.intercept.setxattr: "true"');
      expect(content).toContain("network: lxdbr0");
      expect(content).toContain("pool: {{ terrarium_lxd_pool_name }}");
    }

    expect(defaultProfile).toContain("name: default");
    expect(terrariumProfile).toContain("name: terrarium");
    expect(tasks).toContain("Apply Terrarium-managed LXD profiles");
    expect(tasks).toContain('name: "default"');
    expect(tasks).toContain('name: "terrarium"');
  });

  test("pre-creates strict and KVM profiles for explicit workload choices", () => {
    const strictProfile = readRepoFile("ansible/roles/lxd/templates/strict-profile.yml.j2");
    const kvmProfile = readRepoFile("ansible/roles/lxd/templates/kvm-profile.yml.j2");
    const tasks = readRepoFile("ansible/roles/lxd/tasks/main.yml");

    expect(strictProfile).toContain("name: strict");
    expect(strictProfile).toContain('security.idmap.isolated: "true"');
    expect(strictProfile).not.toContain("security.nesting");
    expect(strictProfile).not.toContain("security.syscalls.intercept");
    expect(strictProfile).toContain("network: lxdbr0");
    expect(strictProfile).toContain("pool: {{ terrarium_lxd_pool_name }}");

    expect(kvmProfile).toContain("name: kvm");
    expect(kvmProfile).toContain('security.nesting: "true"');
    expect(kvmProfile).toContain("source: /dev/kvm");
    expect(kvmProfile).toContain("type: unix-char");

    expect(tasks).toContain('name: "strict"');
    expect(tasks).toContain("Check whether host exposes KVM");
    expect(tasks).toContain("path: /dev/kvm");
    expect(tasks).toContain("when: terrarium_lxd_kvm_device.stat.exists");
  });
});
