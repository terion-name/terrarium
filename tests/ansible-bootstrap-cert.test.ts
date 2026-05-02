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
    const dynamicConfig = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/terrarium-dynamic.yml.j2"), "utf8");
    const bootstrapRoutes = readFileSync(join(repoRoot, "ansible/roles/traefik/templates/bootstrap-routes.yml.j2"), "utf8");

    expect(tasks).toContain("[terrarium_auth_domain] if terrarium_bootstrap_tls_enabled else []");
    expect(tasks).not.toContain("'*.' ~ terrarium_bootstrap_tls_root_domain");
    expect(certConfig).toContain("certificates:");
    expect(certConfig).not.toContain("defaultCertificate");
    expect(dynamicConfig).not.toContain("zitadel-root-bootstrap");
    expect(bootstrapRoutes).toContain("zitadel-root-bootstrap");
    expect(tasks).toContain("Remove Traefik bootstrap certificate config when bootstrap TLS is not required");
    expect(tasks).toContain("Remove temporary Traefik bootstrap routes when bootstrap TLS is not required");
    expect(tasks).toContain("systemctl try-restart snap.lxd.daemon.service");
    expect(playbook).toContain("Remove local auth bootstrap TLS material before requesting public TLS");
    expect(playbook).toContain("dynamic/bootstrap-routes.yml");
    expect(playbook).toContain("Wait for local auth domain to serve public TLS");
    expect(playbook).toContain("Restart Traefik to retry local auth ACME after public TLS wait failure");
    expect(playbook).toContain("Wait again for local auth domain to serve public TLS after ACME retry");
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

  test("retries local ZITADEL reconciliation after service restarts", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/tasks/main.yml"), "utf8");

    expect(tasks).toContain("register: terrarium_zitadel_sync");
    expect(tasks).toContain("until: terrarium_zitadel_sync.rc == 0");
    expect(tasks).toContain("retries: 6");
  });

  test("retries transient Traefik release download failures", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");

    expect(tasks).toContain("register: terrarium_traefik_download");
    expect(tasks).toContain("until: terrarium_traefik_download is succeeded");
    expect(tasks).toContain("retries: 5");
  });

  test("installs Traefik from a pinned archive through private staging", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/traefik/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/traefik/tasks/main.yml"), "utf8");

    expect(defaults).toContain("terrarium_traefik_download_dir: /var/lib/terrarium/downloads/traefik");
    expect(defaults).toContain("terrarium_traefik_stage_dir: /var/lib/terrarium/staging/traefik");
    expect(defaults).toContain("terrarium_traefik_sha256:");
    expect(tasks).toContain("Create private Traefik release work directories");
    expect(tasks).toContain('mode: "0700"');
    expect(tasks).toContain("checksum: \"sha256:{{ terrarium_traefik_archive_checksum }}\"");
    expect(tasks).toContain("Validate Traefik release archive metadata");
    expect(tasks).toContain("unexpected Traefik archive member");
    expect(tasks).toContain("tar -tvzf \"$archive\" | awk '$1 ~ /^[hlbcps]/");
    expect(tasks).toContain("install -o root -g root -m 0755");
    expect(tasks).not.toContain("dest: /tmp");
    expect(tasks).not.toContain("src: /tmp/traefik");
    expect(tasks).not.toContain("ansible.builtin.unarchive");
  });
});
