import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

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
});
