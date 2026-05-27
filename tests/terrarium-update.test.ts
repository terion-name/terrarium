import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checksumForReleaseAsset } from "../scripts/ctl/update";

const repoRoot = join(import.meta.dir, "..");

describe("terrarium update command", () => {
  test("updates release bundle installs without rerunning the install wizard", () => {
    const ctl = readFileSync(join(repoRoot, "scripts/terrariumctl.ts"), "utf8");
    const update = readFileSync(join(repoRoot, "scripts/ctl/update.ts"), "utf8");

    expect(ctl).toContain('.command("update"');
    expect(ctl).toContain('option("--ref <ref>"');
    expect(ctl).toContain('option("--skip-reconfigure"');
    expect(ctl).toContain('option("--non-interactive"');
    expect(update).toContain("TERRARIUM_BUNDLE_DIR");
    expect(update).toContain("syncTree(BUNDLE_DIR, REPO_DIR)");
    expect(update).toContain("GITHUB_CLI_APT_KEYRING");
    expect(update).toContain("https://cli.github.com/packages");
    expect(update).toContain("githubcli-archive-keyring.gpg");
    expect(update).toContain('"dpkg", "--print-architecture"');
    expect(update).toContain('"chown", "root:root", GITHUB_CLI_APT_KEYRING');
    expect(update).toContain("chmodSync(GITHUB_CLI_APT_KEYRING, 0o644)");
    expect(update).toContain('"chown", "root:root", GITHUB_CLI_APT_SOURCE');
    expect(update).toContain("chmodSync(GITHUB_CLI_APT_SOURCE, 0o644)");
    expect(update).toContain('"git", "gh", "python3", "python3-venv", "jq", "unzip"');
    expect(update).toContain('"gh", "attestation", "verify", "--help"');
    expect(update).toContain("ensureAnsibleRuntime");
    expect(update).toContain("ansible==${TERRARIUM_ANSIBLE_VERSION}");
    expect(update).toContain("TERRARIUM_ANSIBLE_GALAXY");
    expect(update).toContain("SHA256SUMS");
    expect(update).toContain('const RELEASE_ATTESTATION_BUNDLE = "terrarium-release-attestation.sigstore.json"');
    expect(update).toContain("verifyReleaseChecksum");
    expect(update).toContain("gh");
    expect(update).toContain("attestation");
    expect(update).toContain('"--bundle"');
    expect(update).toContain("join(workDir, RELEASE_ATTESTATION_BUNDLE)");
    expect(update).toContain("--signer-workflow");
    expect(update).toContain(".github/workflows/release.yml");
    expect(update).toContain("refusing to sync Terrarium source onto itself");
    expect(update).toContain('existsSync("/opt/bun/bin/bun") ? "/opt/bun/bin/bun" : "bun"');
    expect(update).toContain("installAnsibleCollections");
    expect(update).toContain("reconfigureCmd({ applyHardening: false })");
    expect(update).toContain("installCompiledCli");
    expect(update).toContain('"completion", "all", "install"');
    expect(update).not.toContain("interactiveConfig");
    expect(update).not.toContain("confirmDestructiveActions");
  });

  test("parses release checksum lines for the selected asset only", () => {
    const checksums = [
      "f".repeat(64) + "  install.sh",
      "a".repeat(64) + "  *terrarium-linux-x64.zip",
      "b".repeat(64) + "  terrarium-linux-arm64.zip"
    ].join("\n");

    expect(checksumForReleaseAsset(checksums, "terrarium-linux-x64.zip")).toBe("a".repeat(64));
    expect(() => checksumForReleaseAsset(checksums, "terrarium-linux-riscv64.zip")).toThrow("missing checksum");
  });
});
