import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("install.sh bootstrap", () => {
  test("fails closed when the latest release cannot be resolved", () => {
    const source = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain('resolved_ref="$(resolve_latest_tag "${arch}")" || die "failed to resolve latest Terrarium release tag"');
    expect(source).toContain('TERRARIUM_ASSET="terrarium-linux-${arch}.zip"');
    expect(source).toContain('[[ -n "${resolved_ref}" ]] || die "failed to resolve latest Terrarium release tag"');
    expect(source).toContain("SHA256SUMS");
    expect(source).toContain("terrarium-release-attestation.sigstore.json");
    expect(source).toContain("sha256sum -c -");
    expect(source).toContain("gh attestation verify");
    expect(source).toContain('--bundle "${bundle_dir}/${attestation_name}"');
    expect(source).toContain("--signer-workflow");
    expect(source).not.toContain("head -n1 || true");
    expect(source).not.toContain("} || true");
  });

  test("uses source fallback only for explicit branch-like refs", () => {
    const source = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain("UPDATE=false");
    expect(source).toContain("--update");
    expect(source).toContain('if [[ -n "${BOOTSTRAP_REF}" ]]; then');
    expect(source).toContain(
      'install_release_bundle "${tmpdir}" "${arch}" "${BOOTSTRAP_REF}" || die "Terrarium install failed for release bundle ${BOOTSTRAP_REF}"'
    );
    expect(source).toContain(
      'install_release_bundle "${tmpdir}" "${arch}" "${resolved_ref}" || die "Terrarium install failed for release bundle ${resolved_ref}"'
    );
    expect(source).toContain('if is_release_ref "${REF}"; then');
    expect(source).toContain('install_release_bundle "${tmpdir}" "${arch}" "${REF}" || die "Terrarium install failed for release bundle ${REF}"');
    expect(source).toContain('download_release_bundle "${bundle_dir}" "${arch}" "${resolved_ref}" || die "failed to download Terrarium release bundle ${resolved_ref}"');
    expect(source).toContain('"${terrariumctl}" update --ref "${ref}" "$@"');
    expect(source.indexOf("if is_non_interactive_install; then")).toBeLessThan(source.indexOf("exec {tty_fd}</dev/tty"));
    expect(source).toContain('"${terrariumctl}" install --ref "${ref}" "$@" <&"${tty_fd}"');
    expect(source).toContain('build_from_source "${tmpdir}" "${REF}"');
    expect(source).not.toContain('build_from_source "${tmpdir}" "main"');
    expect(source).not.toContain("release bundle is unavailable; using source fallback");
  });

  test("waits for dpkg locks during bootstrap package installs", () => {
    const source = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain("DPkg::Lock::Timeout=900");
    expect(source).toContain("apt-get -o DPkg::Lock::Timeout=900 install -y ca-certificates curl");
    expect(source).toContain("https://cli.github.com/packages/githubcli-archive-keyring.gpg");
    expect(source).toContain("chown root:root /etc/apt/keyrings/githubcli-archive-keyring.gpg");
    expect(source).toContain("chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg");
    expect(source).toContain("install -o root -g root -m 0644 /dev/null /etc/apt/sources.list.d/github-cli.list");
    expect(source).toContain("/etc/apt/sources.list.d/github-cli.list");
    expect(source).toContain("https://cli.github.com/packages stable main");
    expect(source).toContain("apt-get -o DPkg::Lock::Timeout=900 install -y gh unzip python3");
    expect(source).toContain("gh attestation verify --help >/dev/null || die");
    expect(source).toContain("apt-get -o DPkg::Lock::Timeout=900 install -y git");
  });

  test("creates bootstrap workspace under a private Terrarium-owned parent", () => {
    const source = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain('bootstrap_parent="/var/lib/terrarium/bootstrap"');
    expect(source).toContain('install -d -o root -g root -m 0700 "${bootstrap_parent}"');
    expect(source).toContain('TMPDIR_PATH="$(mktemp -d "${bootstrap_parent}/run.XXXXXX")"');
    expect(source).toContain('chmod 0700 "${TMPDIR_PATH}"');
    expect(source).not.toContain("mktemp -d /tmp/terrarium-bootstrap.XXXXXX");
  });
});
