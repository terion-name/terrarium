import { describe, expect, test } from "bun:test";
import { cac } from "cac";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  buildConfig,
  defaultOptions,
  externalOidcSetupInstructions,
  externalZitadelGroupsClaimActionScript,
  generateRootPassword,
  installReviewSummary,
  normalizeOidcIssuer,
  partitionEndForCandidate,
  readCliOption,
  registerInstallCommand
} from "./terrarium-install";

const repoRoot = join(import.meta.dir, "..");

describe("terrarium install CLI parsing", () => {
  test("recovers exact numeric-looking OIDC client IDs from argv when cac coerces them", () => {
    const cli = cac("terrariumctl");
    const managementClientId = "370342054720506035";
    const lxdClientId = "370342055777410480";
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "terrariumctl",
      "install",
      "--oidc-client",
      managementClientId,
      "--lxd-oidc-client",
      lxdClientId
    ];

    try {
      registerInstallCommand(cli);
      const parsed = cli.parse(process.argv, { run: false });

      expect(readCliOption(parsed.options, "oidcClient", ["oidc-client"])).toBe(managementClientId);
      expect(readCliOption(parsed.options, "lxdOidcClient", ["lxd-oidc-client"])).toBe(lxdClientId);
    } finally {
      process.argv = originalArgv;
    }
  });

  test("maps IDP provider/default flags from CLI options", () => {
    const cli = cac("terrariumctl");
    const originalArgv = process.argv;
    process.argv = [
      "node",
      "terrariumctl",
      "install",
      "--idp-provider",
      "logto",
      "--oidc-groups-claim",
      "roles",
      "--oidc-scopes",
      "openid profile email roles",
      "--lxd-oidc-groups-claim",
      "lxd_roles",
      "--lxd-oidc-scopes",
      "openid profile email lxd",
      "--local-idp-outputs-path",
      "/etc/terrarium/idp-apps.json"
    ];

    try {
      registerInstallCommand(cli);
      const parsed = cli.parse(process.argv, { run: false });

      expect(readCliOption(parsed.options, "idpProvider", ["idp-provider"])).toBe("logto");
      expect(readCliOption(parsed.options, "oidcGroupsClaim", ["oidc-groups-claim"])).toBe("roles");
      expect(readCliOption(parsed.options, "oidcScopes", ["oidc-scopes"])).toBe("openid profile email roles");
      expect(readCliOption(parsed.options, "lxdOidcGroupsClaim", ["lxd-oidc-groups-claim"])).toBe("lxd_roles");
      expect(readCliOption(parsed.options, "lxdOidcScopes", ["lxd-oidc-scopes"])).toBe("openid profile email lxd");
      expect(readCliOption(parsed.options, "localIdpOutputsPath", ["local-idp-outputs-path"])).toBe("/etc/terrarium/idp-apps.json");
    } finally {
      process.argv = originalArgv;
    }
  });

  test("caps auto free-space partition end using explicit storage size", () => {
    expect(
      partitionEndForCandidate(
        {
          kind: "free-space",
          source: "/dev/sdb",
          sizeBytes: 38 * 1024 * 1024 * 1024,
          sizeLabel: "38G",
          description: "/dev/sdb free space",
          startMiB: "2048MiB",
          endMiB: "40960MiB"
        },
        "32G"
      )
    ).toBe("34816MiB");
  });

  test("preserves explicit OIDC issuer root trailing slash", () => {
    expect(normalizeOidcIssuer("https://issuer.example.test", "--oidc")).toBe("https://issuer.example.test");
    expect(normalizeOidcIssuer("https://issuer.example.test/", "--oidc")).toBe("https://issuer.example.test/");
    expect(normalizeOidcIssuer("https://issuer.example.test/tenant/", "--oidc")).toBe("https://issuer.example.test/tenant/");
  });

  test("omits IDP provider/default config keys when installer options are empty", () => {
    const config = parse(buildConfig(defaultOptions())) as Record<string, unknown>;

    expect(config.terrarium_idp_mode).toBe("");
    expect(config).not.toHaveProperty("terrarium_idp_provider");
    expect(config).not.toHaveProperty("terrarium_oidc_groups_claim");
    expect(config).not.toHaveProperty("terrarium_oidc_scopes");
    expect(config).not.toHaveProperty("terrarium_lxd_oidc_groups_claim");
    expect(config).not.toHaveProperty("terrarium_lxd_oidc_scopes");
    expect(config).not.toHaveProperty("terrarium_local_idp_outputs_path");
  });

  test("adds trimmed IDP provider/default config keys when installer options are set", () => {
    const options = defaultOptions();
    options.idpProvider = " logto ";
    options.oidcGroupsClaim = " roles ";
    options.oidcScopes = " openid profile email roles ";
    options.lxdOidcGroupsClaim = " lxd_roles ";
    options.lxdOidcScopes = " openid profile email lxd ";
    options.localIdpOutputsPath = " /etc/terrarium/idp-apps.json ";

    const config = parse(buildConfig(options)) as Record<string, unknown>;

    expect(config.terrarium_idp_provider).toBe("logto");
    expect(config.terrarium_oidc_groups_claim).toBe("roles");
    expect(config.terrarium_oidc_scopes).toBe("openid profile email roles");
    expect(config.terrarium_lxd_oidc_groups_claim).toBe("lxd_roles");
    expect(config.terrarium_lxd_oidc_scopes).toBe("openid profile email lxd");
    expect(config.terrarium_local_idp_outputs_path).toBe("/etc/terrarium/idp-apps.json");
  });

  test("uses provider-aware local issuer shape for local installs", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain("resolveLocalOidcIssuer(options.authDomain, localProvider)");
    expect(source).not.toContain('normalizeOidcIssuer(`https://${options.authDomain}/`, "--oidc")');
  });

  test("wires IDP provider/default options through installer source", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain('from "./lib/idp-provider"');
    expect(source).toContain('.option("--idp-provider <provider>"');
    expect(source).toContain('.option("--oidc-groups-claim <claim>"');
    expect(source).toContain('.option("--local-idp-outputs-path <path>"');
    expect(source).toContain('readCliOption(cliOptions, "idpProvider", ["idp-provider"])');
    expect(source).toContain("validatePublicIdpProvider(explicitProvider)");
    expect(source).toContain('resolveEffectiveIdpProvider("oidc", options.idpProvider)');
    expect(source).not.toContain("/zitadel/i.test(options.oidcIssuer");
  });

  test("does not expose the Cockpit root password as an argv option", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).not.toContain('.option("--root-pwd <password>"');
    expect(source).not.toContain('readSecretCliOption(cliOptions, "rootPwd", "rootPwdFile"');
    expect(source).toContain('.option("--generate-root-pwd"');
    expect(source).toContain('readSecretFileCliOption(cliOptions, "rootPwdFile", ["root-pwd-file"])');
    expect(source).toContain('const GENERATED_ROOT_PASSWORD_PATH = "/etc/terrarium/secrets/cockpit_root_password"');
    expect(source).toContain("mode: 0o600");
  });

  test("generates a strong root password without shell-sensitive whitespace", () => {
    const generated = generateRootPassword();

    expect(generated.startsWith("trm-")).toBe(true);
    expect(generated.length).toBeGreaterThanOrEqual(40);
    expect(generated).toMatch(/^trm-[A-Za-z0-9_-]+$/);
  });

  test("retries transient Ansible Galaxy collection download failures", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain("const ANSIBLE_GALAXY_ATTEMPTS = 4");
    expect(source).toContain("async function ensureAnsibleRuntime()");
    expect(source).toContain("TERRARIUM_ANSIBLE_PIP_PACKAGES");
    expect(source).toContain("TERRARIUM_ANSIBLE_WHEELHOUSE");
    expect(source).toContain("--no-index --find-links");
    expect(source).not.toContain("pip install --upgrade pip");
    expect(source).toContain("async function installAnsibleCollections()");
    expect(source).toContain('cd ${join(REPO_DIR, "ansible")}; ${TERRARIUM_ANSIBLE_GALAXY} collection install -r requirements.yml');
    expect(source).toContain("collection install -r requirements.yml");
    expect(source).toContain("failed on attempt ${attempt}/${ANSIBLE_GALAXY_ATTEMPTS}; retrying");
    expect(source).toContain("failed after ${ANSIBLE_GALAXY_ATTEMPTS} attempts");
  });

  test("installs release bundles without cloning the git repository", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain('BUNDLE_DIR && existsSync(join(BUNDLE_DIR, "ansible", "site.yml"))');
    expect(source).toContain("syncInstallBundle(BUNDLE_DIR, REPO_DIR)");
    expect(source).toContain("installing Terrarium release bundle into ${REPO_DIR}");
    expect(source).toContain('cd ${join(REPO_DIR, "ansible")}; ${TERRARIUM_ANSIBLE_PLAYBOOK} -i inventory.ini site.yml');
  });

  test("interactive install offers update when an existing Terrarium config is present", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain("handleExistingInteractiveInstall");
    expect(source).toContain("hasConfigDocument(CONFIG_PATH, PREFIX)");
    expect(source).toContain("Existing Terrarium configuration found. What do you want to do?");
    expect(source).toContain("Update existing installation");
    expect(source).toContain("Reinstall / reconfigure from scratch");
    expect(source).toContain("await updateCmd({ ref: options.ref })");
  });

  test("shows concrete external OIDC setup requirements before provider prompts", () => {
    const instructions = externalOidcSetupInstructions({
      adminGroup: "admin",
      idpProvider: "zitadel",
      lxdDomain: "lxd.example.test",
      manageDomain: "manage.example.test",
      oidcIssuer: "https://issuer.example.test",
      proxyDomain: "proxy.example.test"
    });

    expect(instructions).toContain("https://manage.example.test/oauth2/callback");
    expect(instructions).toContain("https://proxy.example.test/oauth2/callback");
    expect(instructions).toContain("https://lxd.example.test/oidc/callback");
    expect(instructions).toContain("openid profile email");
    expect(instructions).toContain('groups must be a JSON string array containing "admin"');
    expect(instructions).toContain("Project role assignments are not emitted as a flat groups claim by default.");
    expect(instructions).toContain("Copy the Project ID from the ZITADEL project that contains your Terrarium app.");
    expect(instructions).toContain("Create an Action named groupsClaim");
    expect(instructions).toContain("function groupsClaim(ctx, api)");
    expect(instructions).toContain("replace-with-your-terrarium-project-id");
    expect(instructions).toContain("grantProjectId !== terrariumProjectId");
    expect(instructions).toContain("Pre Userinfo creation");
    expect(instructions).toContain("Pre access token creation");
    expect(instructions).toContain("https://<route-host>/oauth2/callback");
    expect(instructions).toContain("https://<route-host>/oauth2/<path>/callback");
    expect(instructions).not.toContain("/oauth2/route/.../callback");
  });

  test("external OIDC instructions default to generic provider guidance when provider is omitted", () => {
    const instructions = externalOidcSetupInstructions({
      adminGroup: "admin",
      lxdDomain: "lxd.example.test",
      manageDomain: "manage.example.test",
      oidcIssuer: "https://tenant.us1.zitadel.cloud",
      proxyDomain: "proxy.example.test"
    });

    expect(instructions).toContain("Scopes:     openid profile email");
    expect(instructions).toContain('Claim:      groups must be a JSON string array containing "admin"');
    expect(instructions).toContain("LXD scopes: openid profile email");
    expect(instructions).toContain('LXD claim:  groups must be a JSON string array containing "admin"');
    expect(instructions).not.toContain("ZITADEL Cloud note:");
  });

  test("external OIDC instructions use Logto defaults for explicit Logto provider", () => {
    const instructions = externalOidcSetupInstructions({
      adminGroup: "admin",
      idpProvider: "logto",
      lxdDomain: "lxd.example.test",
      manageDomain: "manage.example.test",
      oidcIssuer: "https://auth.example.test",
      proxyDomain: "proxy.example.test"
    });

    expect(instructions).toContain("Scopes:     openid profile email roles");
    expect(instructions).toContain('Claim:      roles must be a JSON string array containing "admin"');
    expect(instructions).toContain("LXD scopes: openid profile email roles");
    expect(instructions).toContain('LXD claim:  roles must be a JSON string array containing "admin"');
    expect(instructions).not.toContain("ZITADEL Cloud note:");
  });

  test("external OIDC instructions reject generic as an explicit public provider", () => {
    expect(() =>
      externalOidcSetupInstructions({
        adminGroup: "admin",
        idpProvider: "generic",
        lxdDomain: "lxd.example.test",
        manageDomain: "manage.example.test",
        oidcIssuer: "https://issuer.example.test",
        proxyDomain: "proxy.example.test"
      })
    ).toThrow('invalid IDP provider "generic"; expected one of: zitadel, logto');
  });

  test("ZITADEL Cloud groups action ignores roles from unrelated projects", () => {
    const script = externalZitadelGroupsClaimActionScript("project-terrarium");
    const groupsClaim = new Function(`${script}; return groupsClaim;`)() as (ctx: unknown, api: unknown) => void;
    let emittedGroups: string[] = [];

    groupsClaim(
      {
        v1: {
          user: {
            grants: {
              grants: [
                { projectId: "project-unrelated", roles: ["admin", "ops"] },
                { projectID: "project-terrarium", roles: ["viewer"] },
                { project_id: "project-terrarium", roles: ["admin"] }
              ]
            }
          }
        }
      },
      {
        v1: {
          claims: {
            setClaim(name: string, value: string[]) {
              if (name === "groups") {
                emittedGroups = value;
              }
            }
          }
        }
      }
    );

    expect(emittedGroups).toEqual(["viewer", "admin"]);
  });

  test("summarizes optional integrations so accidental choices can be corrected before install", () => {
    const summary = installReviewSummary({
      enableS3: false,
      enableSyncoid: true,
      s3Bucket: "",
      s3Endpoint: "",
      s3Prefix: "terrarium",
      syncoidTarget: "backup@example.test",
      syncoidTargetDataset: "backup/terrarium"
    });

    expect(summary).toContain("S3 archive backups: disabled");
    expect(summary).toContain("syncoid replication: enabled (backup@example.test:backup/terrarium)");
  });
});
