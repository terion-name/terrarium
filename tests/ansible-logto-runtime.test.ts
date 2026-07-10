import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const roleRoot = join(repoRoot, "ansible/roles/idp_logto");

function roleFile(path: string) {
  return readFileSync(join(roleRoot, path), "utf8");
}

describe("Ansible Logto runtime role", () => {
  test("ships the expected role files and templates", () => {
    for (const path of [
      "defaults/main.yml",
      "tasks/main.yml",
      "handlers/main.yml",
      "templates/docker-compose.yml.j2",
      "templates/terrarium-logto.service.j2"
    ]) {
      expect(existsSync(join(roleRoot, path))).toBe(true);
    }
  });

  test("defaults to the shared local IdP instance and Logto ports", () => {
    const defaults = roleFile("defaults/main.yml");

    expect(defaults).toContain("terrarium_logto_enabled:");
    expect(defaults).toContain("terrarium_idp_provider_effective");
    expect(defaults).toContain("== 'logto'");
    expect(defaults).toContain("terrarium_logto_instance_name: terrarium-idp");
    expect(defaults).toContain("terrarium_logto_instance_image: ubuntu:24.04");
    expect(defaults).toContain("terrarium_logto_instance_profile: terrarium");
    expect(defaults).toContain("terrarium_logto_core_port: 3001");
    expect(defaults).toContain("terrarium_logto_admin_port: 3002");
    expect(defaults).toContain('terrarium_logto_admin_email: "{{ terrarium_email }}"');
    expect(defaults).toContain("terrarium_logto_admin_username: terrarium_admin");
    expect(defaults).toContain('terrarium_logto_dir: "{{ terrarium_state_dir }}/logto"');
    expect(defaults).toContain('terrarium_logto_postgres_dir: "{{ terrarium_logto_dir }}/postgres"');
    expect(defaults).toContain('terrarium_logto_seed_dir: "{{ terrarium_logto_dir }}/seed"');
    expect(defaults).toContain('terrarium_logto_stage_dir: "{{ terrarium_state_dir }}/logto-container"');
    expect(defaults).toContain('terrarium_logto_app_image: ""');
    expect(defaults).toContain('terrarium_logto_app_image_fallback: "ghcr.io/logto-io/logto:latest"');
    expect(defaults).toContain('terrarium_logto_postgres_image: ""');
    expect(defaults).toContain("terrarium_logto_postgres_image_hardened");
    expect(defaults).toContain("terrarium_logto_postgres_image_mirror");
    expect(defaults).toContain("terrarium_logto_postgres_image_fallback");
  });

  test("configures Logto in the shared LXD system instance without deleting provider state", () => {
    const tasks = roleFile("tasks/main.yml");
    const startServiceIndex = tasks.indexOf("Start or restart Logto compose service inside system instance");
    const proxyIndex = tasks.indexOf("Ensure host loopback proxies reach the Logto system instance");
    const adminPasswordReadIndex = tasks.indexOf("Read Logto local admin password from system instance");
    const syncIndex = tasks.indexOf("Run Logto reconciliation");
    const disabledIndex = tasks.indexOf("- name: Disable self-hosted Logto service when not enabled");
    const disabledBlock = tasks.slice(disabledIndex);

    expect(tasks).toContain("Stop legacy host Logto compose service");
    expect(tasks).toContain("Remove legacy host Logto systemd unit");
    expect(tasks).toContain("notify: reload terrarium logto systemd");
    expect(tasks).toContain("Check whether Logto system instance exists");
    expect(tasks).toContain("/snap/bin/lxc info {{ terrarium_logto_instance_name }}");
    expect(tasks).toContain("Resolve local LXD member for first Logto placement");
    expect(tasks).toContain("Assert local LXD member was resolved for first Logto placement");
    expect(tasks).toContain("Launch Logto system instance");
    expect(tasks).toContain("--target {{ terrarium_logto_instance_target | default(ansible_hostname) }}");
    expect(tasks).toContain("boot.autostart");
    expect(tasks).toContain("user.terrarium.system");
    expect(tasks).toContain("Wait for cloud-init in Logto system instance");
    expect(tasks).toContain("Install Docker runtime inside Logto system instance");
    expect(tasks).toContain("docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin");
    expect(tasks).toContain("Create Logto root directories inside system instance");
    expect(tasks).toContain("Create Logto Postgres data directory inside system instance");
    expect(tasks).toContain("-m 0700");
    expect(tasks).toContain("Generate Logto secrets inside system instance");
    expect(tasks).toContain("logto_postgres_password");
    expect(tasks).toContain("logto_secret_vault_kek");
    expect(tasks).toContain("logto_admin_password");
    expect(tasks).toContain("/etc/terrarium/secrets/logto_admin_password");
    expect(tasks).toContain('pw="$(tr -dc "A-Z" </dev/urandom | head -c 1)$(tr -dc "a-z" </dev/urandom | head -c 1)$(tr -dc "0-9" </dev/urandom | head -c 1)!$(tr -dc "A-Za-z0-9" </dev/urandom | head -c 28)"');
    expect(tasks).toContain("Copy Docker registry credentials into Logto system instance when present");
    expect(tasks).toContain("Resolve Logto app image");
    expect(tasks).toContain("Resolve Logto Postgres image");
    expect(tasks).toContain("Read Logto Postgres password from system instance");
    expect(tasks).toContain("Read Logto secret vault KEK from system instance");
    expect(tasks).toContain("Read Logto local admin password from system instance");
    expect(tasks).toContain("register: terrarium_logto_admin_password_raw");
    expect(tasks).toContain("Render Logto compose stack for system instance");
    expect(tasks).toContain("Push Logto compose stack into system instance");
    expect(tasks).toContain("systemctl enable terrarium-logto.service");
    expect(tasks).toContain("Start or restart Logto compose service inside system instance");
    expect(tasks).toContain("Ensure host loopback proxies reach the Logto system instance");
    expect(tasks).toContain("ensure_proxy terrarium-logto-core {{ terrarium_logto_core_port }}");
    expect(tasks).toContain("ensure_proxy terrarium-logto-admin {{ terrarium_logto_admin_port }}");
    expect(tasks).toContain("Run Logto reconciliation");
    expect(tasks).toContain("/usr/local/bin/terrariumctl idp sync");
    expect(tasks).toContain("environment:\n        TERRARIUM_LOGTO_ADMIN_PASSWORD: \"{{ terrarium_logto_admin_password_raw.stdout }}\"");
    expect(tasks).not.toContain("TERRARIUM_LOGTO_ADMIN_PASSWORD: \"{{ terrarium_root_password_plaintext");
    expect(tasks.slice(adminPasswordReadIndex, syncIndex)).toContain("no_log: true");
    expect(tasks.slice(syncIndex, disabledIndex)).toContain("no_log: true");
    expect(tasks).toContain("register: terrarium_logto_sync");
    expect(tasks).toContain("until: terrarium_logto_sync.rc == 0");
    expect(tasks).toContain("retries: 6");
    expect(tasks).toContain("delay: 10");
    expect(proxyIndex).toBeGreaterThan(startServiceIndex);
    expect(adminPasswordReadIndex).toBeGreaterThan(0);
    expect(syncIndex).toBeGreaterThan(proxyIndex);
    expect(syncIndex).toBeGreaterThan(adminPasswordReadIndex);
    expect(disabledIndex).toBeGreaterThan(syncIndex);
    expect(tasks.match(/no_log: true/g)?.length).toBeGreaterThanOrEqual(8);

    expect(tasks).not.toContain("lxc delete");
    expect(disabledBlock).toContain("Stop and disable legacy host Logto compose service");
    expect(disabledBlock).toContain("Stop Logto service inside system instance when present");
    expect(disabledBlock).not.toContain("lxc config device remove");
    expect(disabledBlock).not.toContain("lxc config device add");
    expect(disabledBlock).not.toContain("state: absent");
    expect(disabledBlock).not.toContain("rm -rf");
    expect(disabledBlock).not.toContain("{{ terrarium_logto_dir }}");
  });

  test("renders a private Logto compose stack with seeded Postgres and loopback ports", () => {
    const compose = roleFile("templates/docker-compose.yml.j2");

    expect(compose).toContain("postgres:");
    expect(compose).toContain("image: {{ terrarium_logto_postgres_image_effective }}");
    expect(compose).toContain("POSTGRES_USER: logto");
    expect(compose).toContain("POSTGRES_PASSWORD: \"{{ terrarium_logto_postgres_password }}\"");
    expect(compose).toContain("POSTGRES_DB: logto");
    expect(compose).toContain("pg_isready -d logto -U logto");
    expect(compose).toContain('"{{ terrarium_logto_postgres_dir }}:/var/lib/postgresql/data:rw"');
    expect(compose).toContain("DB_URL: \"postgresql://logto:{{ terrarium_logto_postgres_password }}@postgres:5432/logto\"");
    expect(compose).toContain("ENDPOINT: \"https://{{ terrarium_auth_domain }}\"");
    expect(compose).not.toContain("ENDPOINT: \"https://{{ terrarium_auth_domain }}/oidc\"");
    expect(compose).toContain("TRUST_PROXY_HEADER: \"1\"");
    expect(compose).toContain("ADMIN_PORT: \"3002\"");
    expect(compose).toContain("ADMIN_ENDPOINT: \"https://{{ terrarium_auth_domain }}/console\"");
    expect(compose).toContain("SECRET_VAULT_KEK: \"{{ terrarium_logto_secret_vault_kek }}\"");
    expect(compose).toContain('entrypoint: ["/bin/sh", "-c"]');
    expect(compose).toContain('command: ["npm run cli db seed -- --swe"]');
    expect(compose).toContain("logto-seed:");
    expect(compose).toContain("profiles:\n      - seed");
    expect(compose).not.toContain("condition: service_completed_successfully");
    expect(compose).toContain('"127.0.0.1:{{ terrarium_logto_core_port }}:3001"');
    expect(compose).toContain('"127.0.0.1:{{ terrarium_logto_admin_port }}:3002"');
  });

  test("renders a systemd unit matching the Docker Compose lifecycle", () => {
    const unit = roleFile("templates/terrarium-logto.service.j2");

    expect(unit).toContain("Requires=docker.service");
    expect(unit).toContain("After=docker.service network-online.target");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("RemainAfterExit=yes");
    expect(unit).toContain("WorkingDirectory={{ terrarium_logto_dir }}");
    expect(unit).toContain("docker compose --project-name terrarium-logto");
    expect(unit).toContain("ExecStartPre=/usr/bin/docker compose --project-name terrarium-logto -f {{ terrarium_logto_dir }}/docker-compose.yml up -d --wait --wait-timeout 600 postgres");
    expect(unit).toContain("ExecStartPre=/usr/bin/docker compose --project-name terrarium-logto -f {{ terrarium_logto_dir }}/docker-compose.yml run --rm --no-deps logto-seed");
    expect(unit).toContain("ExecStart=/usr/bin/docker compose --project-name terrarium-logto -f {{ terrarium_logto_dir }}/docker-compose.yml up -d --wait --wait-timeout 600 --remove-orphans postgres logto");
    expect(unit).toContain("ExecStop=/usr/bin/docker compose --project-name terrarium-logto -f {{ terrarium_logto_dir }}/docker-compose.yml down");
    expect(unit).toContain("TimeoutStartSec=900");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  test("has a Logto-specific host systemd reload handler", () => {
    const handlers = roleFile("handlers/main.yml");

    expect(handlers).toContain("reload terrarium logto systemd");
    expect(handlers).toContain("daemon_reload: true");
  });
});
