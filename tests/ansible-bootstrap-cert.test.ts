import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..");

describe("Traefik bootstrap certificate template", () => {
  test("marks the self-signed bootstrap certificate as a CA trusted for server auth", () => {
    const template = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-cert-openssl.cnf.j2"), "utf8");

    expect(template).toContain("basicConstraints = critical, CA:true");
    expect(template).toContain("keyCertSign");
    expect(template).toContain("extendedKeyUsage = serverAuth");
  });

  test("keeps covered auth domains from rotating the bootstrap cert across IDP mode switches", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");

    expect(tasks).toContain("terrarium_auth_domain.endswith('.' ~ terrarium_bootstrap_tls_root_domain)");
    expect(tasks).toContain("systemctl try-restart snap.lxd.daemon.service");
  });
});
