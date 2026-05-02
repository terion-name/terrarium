import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("base role packages", () => {
  test("installs storage, network, and kernel support packages", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/base/defaults/main.yml"), "utf8");

    expect(defaults).toContain("- cifs-utils");
    expect(defaults).toContain("- wireguard-tools");
    expect(defaults).toContain('- "linux-modules-extra-{{ ansible_kernel }}"');
  });
});

describe("cluster firewall", () => {
  test("opens WireGuard publicly only for invited endpoints and LXD/OVN only for tunnel peers", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Allow WireGuard mesh from configured peer endpoints");
    expect(tasks).toContain("terrarium_cluster_wireguard_endpoint_cidrs");
    expect(tasks).toContain("terrarium_cluster_wireguard_port");
    expect(tasks).toContain("Allow LXD cluster API from configured peer networks");
    expect(tasks).toContain("terrarium_cluster_peer_cidrs");
    expect(tasks).toContain("'6081'");
    expect(tasks).toContain("'6641'");
    expect(tasks).toContain("'6642'");
  });

  test("renders WireGuard from local private key and registered cluster members", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");
    const template = readFileSync(join(repoRoot, "ansible/roles/base/templates/wireguard.conf.j2"), "utf8");
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(site).toContain("terrarium_cluster_wireguard_enabled");
    expect(site).toContain("terrarium_cluster_wireguard_members");
    expect(tasks).toContain("Resolve local WireGuard public key");
    expect(tasks).toContain("Use WireGuard tunnel address for clustered LXD and OVN");
    expect(tasks).toContain("wg-quick@{{ terrarium_cluster_wireguard_interface }}");
    expect(template).toContain("PrivateKey = {{ terrarium_cluster_wireguard_private_key_plain }}");
    expect(template).toContain("AllowedIPs = {{ peer.tunnel_ip }}/32");
    expect(template).toContain("PersistentKeepalive = 25");
  });
});

describe("config store reconciliation", () => {
  test("imports the local config export into the LXD dqlite store before proxy sync", () => {
    const site = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const importIndex = site.indexOf("terrariumctl config import");
    const proxyIndex = site.indexOf("terrariumctl proxy sync");

    expect(importIndex).toBeGreaterThan(0);
    expect(proxyIndex).toBeGreaterThan(importIndex);
  });
});

describe("terrariumctl install alias", () => {
  test("installs trm as a shorthand symlink to the installed CLI", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/base/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Inspect existing terrariumctl shorthand alias");
    expect(tasks).toContain("Install terrariumctl shorthand alias");
    expect(tasks).toContain("src: /usr/local/bin/terrariumctl");
    expect(tasks).toContain("dest: /usr/local/bin/trm");
    expect(tasks).toContain("state: link");
    expect(tasks).toContain("leaving it untouched");
  });
});

describe("terrariumctl mount defaults", () => {
  test("keeps local CIFS permission checks and applies host hardening flags", () => {
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(mount).not.toContain('"noperm"');
    expect(mount).toContain('"nosuid"');
    expect(mount).toContain('"nodev"');
    expect(mount).toContain('"noexec"');
    expect(mount).toContain('"forceuid"');
    expect(mount).toContain('"forcegid"');
  });

  test("recovers dashed CIFS mode options from the CLI parser", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");

    expect(ctl).toContain('cliOption(rawOptions, "fileMode", ["file-mode"])');
    expect(ctl).toContain('cliOption(rawOptions, "dirMode", ["dir-mode"])');
  });

  test("supports file-based CIFS password input", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const mount = readFileSync(join(repoRoot, "scripts/ctl/mount.ts"), "utf8");

    expect(ctl).toContain("--password-file <path>");
    expect(mount).toContain("passwordFile?: string");
    expect(mount).toContain("readFileSync(options.passwordFile");
  });
});
