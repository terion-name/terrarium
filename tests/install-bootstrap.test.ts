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
    expect(source).not.toContain("head -n1 || true");
    expect(source).not.toContain("} || true");
  });

  test("uses source fallback only for explicit branch-like refs", () => {
    const source = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(source).toContain('if [[ -n "${BOOTSTRAP_REF}" ]]; then');
    expect(source).toContain(
      'download_release_bundle "${tmpdir}" "${arch}" "${BOOTSTRAP_REF}" || die "failed to download Terrarium release bundle ${BOOTSTRAP_REF}"'
    );
    expect(source).toContain(
      'download_release_bundle "${tmpdir}" "${arch}" "${resolved_ref}" || die "failed to download Terrarium release bundle ${resolved_ref}"'
    );
    expect(source).toContain('if is_release_ref "${REF}"; then');
    expect(source).toContain('download_release_bundle "${tmpdir}" "${arch}" "${REF}" || die "failed to download Terrarium release bundle ${REF}"');
    expect(source).toContain('build_from_source "${tmpdir}" "${REF}"');
    expect(source).not.toContain('build_from_source "${tmpdir}" "main"');
    expect(source).not.toContain("release bundle is unavailable; using source fallback");
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
