import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const OAUTH2_PROXY_DHI_IMAGE =
  "dhi.io/oauth2-proxy:7.15.2-debian13@sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";

describe("management oauth2-proxy template", () => {
  test("uses host-only cookies for management hosts", () => {
    const template = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/templates/oauth2-proxy.cfg.j2"), "utf8");

    expect(template).toContain('redirect_url = "/oauth2/callback"');
    expect(template).toContain('cookie_name = "__Host-terrarium_admin_oauth2_proxy"');
    expect(template).toContain('cookie_path = "/"');
    expect(template).toContain('whitelist_domains = [ "{{ terrarium_manage_domain }}", "{{ terrarium_proxy_domain }}" ]');
    expect(template).not.toContain("cookie_domains");
    expect(template).not.toContain("terrarium_oauth2_proxy_cookie_domain");
  });

  test("runs oauth2-proxy without root while keeping secret config non-world-readable", () => {
    const defaults = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/defaults/main.yml"), "utf8");
    const compose = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/templates/docker-compose.yml.j2"), "utf8");
    const tasks = readFileSync(join(import.meta.dir, "../ansible/roles/oauth2_proxy/tasks/main.yml"), "utf8");

    expect(defaults).toContain('terrarium_oauth2_proxy_uid: "65532"');
    expect(defaults).toContain(`terrarium_oauth2_proxy_image: "${OAUTH2_PROXY_DHI_IMAGE}"`);
    expect(compose).toContain('user: "{{ terrarium_oauth2_proxy_uid }}:{{ terrarium_oauth2_proxy_gid }}"');
    expect(tasks).toContain('group: "{{ terrarium_oauth2_proxy_gid }}"');
    expect(tasks).toContain('mode: "0640"');
    expect(compose).not.toContain('user: "0:0"');
    expect(defaults).not.toContain("quay.io/oauth2-proxy");
  });
});
