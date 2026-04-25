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

  test("limits bootstrap TLS to local-IDP auth and removes it when unused", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");
    const playbook = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const certConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-cert.yml.j2"), "utf8");

    expect(tasks).toContain("[terrarium_auth_domain] if terrarium_bootstrap_tls_enabled else []");
    expect(tasks).not.toContain("'*.' ~ terrarium_bootstrap_tls_root_domain");
    expect(certConfig).toContain("certificates:");
    expect(certConfig).not.toContain("defaultCertificate");
    expect(tasks).toContain("Remove Traefik bootstrap certificate config when bootstrap TLS is not required");
    expect(tasks).toContain("systemctl try-restart snap.lxd.daemon.service");
    expect(playbook).toContain("Remove local auth bootstrap TLS material before requesting public TLS");
    expect(playbook).toContain("Wait for local auth domain to serve public TLS");
    expect(playbook).toContain("terrarium_bootstrap_tls_removed is changed");
    expect(playbook.indexOf("Remove local auth bootstrap TLS material before requesting public TLS")).toBeLessThan(
      playbook.indexOf("Wait for local auth domain to serve public TLS")
    );
  });

  test("terminates public TLS for LXD at Traefik instead of passing through LXD self-signed TLS", () => {
    const dynamicConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/terrarium-dynamic.yml.j2"), "utf8");
    const lxdTasks = readFileSync(join(repoRoot, "ansible/roles/lxd/tasks/main.yml"), "utf8");

    expect(dynamicConfig).toContain("rule: Host(`{{ terrarium_lxd_domain }}`)");
    expect(dynamicConfig).toContain("certResolver: letsencrypt");
    expect(dynamicConfig).toContain("url: https://127.0.0.1:8443");
    expect(dynamicConfig).toContain("serversTransport: lxd-loopback");
    expect(dynamicConfig).toContain("insecureSkipVerify: true");
    expect(dynamicConfig).not.toContain("HostSNI(`{{ terrarium_lxd_domain }}`)");
    expect(dynamicConfig).not.toContain("passthrough: true");
    expect(lxdTasks).toContain("Disable LXD ACME certificate management");
    expect(lxdTasks).not.toContain("lxc config set acme.domain");
  });
});
