import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const repoRoot = join(import.meta.dir, "..");

describe("Ansible site playbook", () => {
  test("waits for unattended-upgrades dpkg locks before apt tasks fail", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const [play] = YAML.parse(source);

    expect(play.module_defaults["ansible.builtin.apt"].lock_timeout).toBe(900);
  });

  test("persists provider-aware OIDC defaults in the config bundle", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const [play] = YAML.parse(source);
    const bundle = play.vars.terrarium_config_bundle;

    expect(play.vars.terrarium_idp_provider).toBe("");
    expect(play.vars.terrarium_oidc_groups_claim).toBe("");
    expect(play.vars.terrarium_oidc_scopes).toBe("");
    expect(play.vars.terrarium_lxd_oidc_groups_claim).toBe("");
    expect(play.vars.terrarium_lxd_oidc_scopes).toBe("");
    expect(play.vars.terrarium_local_idp_outputs_path).toBe("");
    expect(play.vars.terrarium_local_idp_outputs_path_default).toBe("/etc/terrarium/idp-apps.json");
    expect(play.vars.terrarium_zitadel_outputs_path).toBe("/etc/terrarium/zitadel-apps.json");

    expect(bundle.terrarium_idp_provider).toBe("{{ terrarium_idp_provider_effective | default(terrarium_idp_provider) }}");
    expect(bundle.terrarium_oidc_groups_claim).toBe("{{ terrarium_oidc_groups_claim_effective | default(terrarium_oidc_groups_claim) }}");
    expect(bundle.terrarium_oidc_scopes).toBe("{{ terrarium_oidc_scopes_effective | default(terrarium_oidc_scopes) }}");
    expect(bundle.terrarium_lxd_oidc_groups_claim).toBe("{{ terrarium_lxd_oidc_groups_claim_effective | default(terrarium_lxd_oidc_groups_claim) }}");
    expect(bundle.terrarium_lxd_oidc_scopes).toBe("{{ terrarium_lxd_oidc_scopes_effective | default(terrarium_lxd_oidc_scopes) }}");
    expect(bundle.terrarium_local_idp_outputs_path).toBe("{{ terrarium_local_idp_outputs_path_effective | default(terrarium_local_idp_outputs_path) }}");
  });

  test("derives Logto defaults without changing generic OIDC and local ZITADEL defaults", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const idpDefaults = readFileSync(join(repoRoot, "ansible/roles/idp_zitadel/defaults/main.yml"), "utf8");
    const lxdDefaults = readFileSync(join(repoRoot, "ansible/roles/lxd/defaults/main.yml"), "utf8");
    const lxdTasks = readFileSync(join(repoRoot, "ansible/roles/lxd/tasks/main.yml"), "utf8");

    expect(source).toContain("else ('zitadel' if terrarium_idp_mode == 'local' else 'generic')");
    expect(source).toContain("else ('roles' if terrarium_idp_provider_effective == 'logto' else 'groups')");
    expect(source).toContain(
      "else ('openid profile email roles' if terrarium_idp_provider_effective == 'logto' else 'openid profile email')"
    );
    expect(source).toContain("'terrarium_idp_provider': terrarium_idp_provider_effective");
    expect(source).toContain("'terrarium_local_idp_outputs_path': terrarium_local_idp_outputs_path_effective");
    expect(idpDefaults).toContain("terrarium_idp_provider_effective");
    expect(idpDefaults).toContain("== 'zitadel'");
    expect(lxdDefaults).toContain("terrarium_lxd_oidc_groups_claim_effective");
    expect(lxdDefaults).toContain("terrarium_lxd_oidc_scopes_effective");
    expect(lxdTasks).toContain("oidc.groups.claim {{ terrarium_lxd_oidc_groups_claim_effective }}");
    expect(lxdTasks).toContain("- oidc.scopes");
    expect(lxdTasks).toContain("- \"{{ terrarium_lxd_oidc_scopes_effective }}\"");
  });

  test("resolves LXD OIDC defaults after base OIDC defaults", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const [play] = YAML.parse(source);
    const preTasks = play.pre_tasks as Array<{
      name?: string;
      "ansible.builtin.set_fact"?: Record<string, string>;
    }>;
    const oidcTaskIndex = preTasks.findIndex((task) => task.name === "Resolve OIDC claim and scope defaults");
    const lxdTaskIndex = preTasks.findIndex((task) => task.name === "Resolve LXD OIDC claim and scope defaults");

    expect(oidcTaskIndex).toBeGreaterThanOrEqual(0);
    expect(lxdTaskIndex).toBeGreaterThan(oidcTaskIndex);

    const oidcFacts = preTasks[oidcTaskIndex]["ansible.builtin.set_fact"] ?? {};
    const lxdFacts = preTasks[lxdTaskIndex]["ansible.builtin.set_fact"] ?? {};

    expect(oidcFacts.terrarium_oidc_groups_claim_effective).toContain("terrarium_idp_provider_effective == 'logto'");
    expect(oidcFacts.terrarium_oidc_scopes_effective).toContain("terrarium_idp_provider_effective == 'logto'");
    expect(oidcFacts.terrarium_lxd_oidc_groups_claim_effective).toBeUndefined();
    expect(oidcFacts.terrarium_lxd_oidc_scopes_effective).toBeUndefined();
    expect(lxdFacts.terrarium_lxd_oidc_groups_claim_effective).toContain("else terrarium_oidc_groups_claim_effective");
    expect(lxdFacts.terrarium_lxd_oidc_scopes_effective).toContain("else terrarium_oidc_scopes_effective");
  });

  test("resolves local issuer and discovery URLs per IdP provider", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(source).toContain("('https://' ~ terrarium_auth_domain ~ '/oidc')");
    expect(source).toContain("if (terrarium_idp_mode == 'local' and terrarium_idp_provider_effective == 'logto')");
    expect(source).toContain("('https://' ~ terrarium_auth_domain)");
    expect(source).toContain("else terrarium_oidc_issuer");
    expect(source).toContain("terrarium_local_idp_discovery_url_effective");
    expect(source).toContain("('https://' ~ terrarium_auth_domain ~ '/oidc/.well-known/openid-configuration')");
    expect(source).toContain("('https://' ~ terrarium_auth_domain ~ '/.well-known/openid-configuration')");
    expect(source).toContain("((terrarium_oidc_issuer | regex_replace('/+$', '')) ~ '/.well-known/openid-configuration')");
  });

  test("uses provider-aware local discovery URL for public TLS waits", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(source.match(/"{{ terrarium_local_idp_discovery_url_effective }}"/g)).toHaveLength(2);
    expect(source).not.toContain('"https://{{ terrarium_auth_domain }}/.well-known/openid-configuration"');
  });

  test("keeps local IdP output fallback provider-aware and legacy-compatible", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(source).toContain("terrarium_local_idp_outputs_path_effective");
    expect(source).toContain("terrarium_local_idp_outputs_path_default: /etc/terrarium/idp-apps.json");
    expect(source).toContain("terrarium_idp_provider_effective == 'logto'");
    expect(source).toContain("terrarium_zitadel_outputs_path_effective");
    expect(source).toContain("/etc/terrarium/zitadel-apps.json");
    expect(source.indexOf("terrarium_local_idp_outputs_path_default")).toBeLessThan(
      source.indexOf("terrarium_zitadel_outputs_path | default('/etc/terrarium/zitadel-apps.json', true)")
    );
    expect(source).toContain("'terrarium_local_idp_outputs_path': terrarium_local_idp_outputs_path_effective");
    expect(source).toContain("'terrarium_zitadel_outputs_path': terrarium_zitadel_outputs_path_effective");
  });

  test("LXD consumes provider-aware local IdP outputs with legacy ZITADEL fallback", () => {
    const defaults = readFileSync(join(repoRoot, "ansible/roles/lxd/defaults/main.yml"), "utf8");
    const tasks = readFileSync(join(repoRoot, "ansible/roles/lxd/tasks/main.yml"), "utf8");

    expect(defaults).toContain("terrarium_local_idp_outputs_path_default: /etc/terrarium/idp-apps.json");
    expect(tasks).toContain("Resolve local IdP output path for LXD");
    expect(tasks).toContain("terrarium_lxd_local_idp_outputs_path_effective");
    expect(tasks).toContain("terrarium_local_idp_outputs_path_effective");
    expect(tasks).toContain("terrarium_local_idp_outputs_path_default");
    expect(tasks).toContain("terrarium_idp_provider_effective | default(terrarium_idp_provider");
    expect(tasks).toContain("'/etc/terrarium/idp-apps.json'");
    expect(tasks).toContain("terrarium_zitadel_outputs_path_effective");
    expect(tasks).toContain("'/etc/terrarium/zitadel-apps.json'");
    expect(tasks).toContain("Read local IdP outputs for LXD local client configuration");
    expect(tasks).toContain("terrarium_lxd_local_idp_outputs");
    expect(tasks).toContain("get('lxd_client_id', {}).get('value', '')");
    expect(tasks).not.toContain("Read ZITADEL outputs for LXD local client configuration");
    expect(tasks).not.toContain("terrarium_lxd_zitadel_outputs");
  });

  test("orders local IdP roles with Logto gated after ZITADEL and before oauth2-proxy", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");

    expect(source.indexOf("- role: lxd")).toBeLessThan(source.indexOf("- role: idp_zitadel"));
    expect(source.indexOf("- role: idp_zitadel")).toBeLessThan(source.indexOf("- role: idp_logto"));
    expect(source.indexOf("- role: idp_logto")).toBeLessThan(source.indexOf("- role: oauth2_proxy"));
    expect(source).toContain("- role: idp_logto\n      when:\n        - terrarium_idp_mode == 'local'\n        - terrarium_idp_provider_effective == 'logto'");
  });

  test("exports Logto runtime vars and image defaults for roles and templates", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const [play] = YAML.parse(source);
    const bundle = play.vars.terrarium_config_bundle;

    expect(play.vars.terrarium_logto_instance_name).toBe("terrarium-idp");
    expect(play.vars.terrarium_logto_instance_image).toBe("ubuntu:24.04");
    expect(play.vars.terrarium_logto_instance_profile).toBe("terrarium");
    expect(play.vars.terrarium_logto_dir).toBe("{{ terrarium_state_dir }}/logto");
    expect(play.vars.terrarium_logto_postgres_dir).toBe("{{ terrarium_logto_dir }}/postgres");
    expect(play.vars.terrarium_logto_seed_dir).toBe("{{ terrarium_logto_dir }}/seed");
    expect(play.vars.terrarium_logto_stage_dir).toBe("{{ terrarium_state_dir }}/logto-container");
    expect(play.vars.terrarium_logto_core_port).toBe(3001);
    expect(play.vars.terrarium_logto_admin_port).toBe(3002);
    expect(play.vars.terrarium_logto_admin_email).toBe("{{ terrarium_email }}");
    expect(play.vars.terrarium_logto_admin_username).toBe("terrarium_admin");
    expect(play.vars.terrarium_logto_app_image).toBe("");
    expect(play.vars.terrarium_logto_app_image_fallback).toBe("ghcr.io/logto-io/logto:latest");
    expect(play.vars.terrarium_logto_postgres_image).toBe("");
    expect(bundle.terrarium_logto_instance_name).toBe("{{ terrarium_logto_instance_name }}");
    expect(bundle.terrarium_logto_core_port).toBe("{{ terrarium_logto_core_port }}");
    expect(bundle.terrarium_logto_admin_port).toBe("{{ terrarium_logto_admin_port }}");
    expect(bundle.terrarium_logto_admin_email).toBe("{{ terrarium_logto_admin_email }}");
    expect(bundle.terrarium_logto_admin_username).toBe("{{ terrarium_logto_admin_username }}");
    expect(bundle.terrarium_logto_app_image).toBe("{{ terrarium_logto_app_image_effective | default(terrarium_logto_app_image_fallback) }}");
    expect(bundle.terrarium_logto_postgres_image).toBe("{{ terrarium_logto_postgres_image_effective | default(terrarium_logto_postgres_image_fallback) }}");
    expect(source).toContain("'terrarium_logto_admin_email': terrarium_logto_admin_email");
    expect(source).toContain("'terrarium_logto_admin_username': terrarium_logto_admin_username");
    expect(source).toContain("'terrarium_logto_app_image': terrarium_logto_app_image_effective");
    expect(source).toContain("'terrarium_logto_postgres_image': terrarium_logto_postgres_image_effective");
  });
});
