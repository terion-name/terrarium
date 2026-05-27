import { describe, expect, test } from "bun:test";
import { cac } from "cac";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
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

  test("uses ZITADEL discovery issuer shape for local installs", () => {
    const source = readFileSync(join(repoRoot, "scripts/terrarium-install.ts"), "utf8");

    expect(source).toContain('normalizeOidcIssuer(`https://${options.authDomain}`, "--oidc")');
    expect(source).not.toContain('normalizeOidcIssuer(`https://${options.authDomain}/`, "--oidc")');
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
      lxdDomain: "lxd.example.test",
      manageDomain: "manage.example.test",
      oidcIssuer: "https://tenant.us1.zitadel.cloud",
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
