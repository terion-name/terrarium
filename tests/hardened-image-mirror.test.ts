import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..");

const OAUTH2_PROXY_DIGEST = "sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const POSTGRES_DIGEST = "sha256:ae0f0ac1f942ff7898bb217e599cc488b5c7a2611a0957daae44c00584a59714";

describe("Docker Hardened Image mirror workflow", () => {
  test("mirrors pinned multi-arch DHI indexes to GHCR with digest checks", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/mirror-hardened-images.yml"), "utf8");
    const script = readFileSync(join(repoRoot, ".github/scripts/mirror-dhi-image.sh"), "utf8");

    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("DOCKERHUB_USERNAME");
    expect(workflow).toContain("DOCKERHUB_TOKEN");
    expect(workflow).toContain("HAS_DOCKERHUB_CREDS");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("skopeo login dhi.io");
    expect(workflow).toContain("skopeo login ghcr.io");
    expect(workflow).toContain("/user/packages/container/${PACKAGE_NAME}/visibility");
    expect(workflow).toContain("/orgs/${GITHUB_REPOSITORY_OWNER}/packages/container/${PACKAGE_NAME}/visibility");
    expect(workflow).toContain(`dhi.io/oauth2-proxy@${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).not.toContain(`dhi.io/oauth2-proxy:7.15.2-debian13@${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain(`ghcr.io/terion-name/terrarium-dhi-oauth2-proxy:7.15.2-debian13`);
    expect(workflow).toContain(`digest: ${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain(`dhi.io/postgres@${POSTGRES_DIGEST}`);
    expect(workflow).not.toContain(`dhi.io/postgres:17.9-alpine3.22-fips@${POSTGRES_DIGEST}`);
    expect(workflow).toContain(`ghcr.io/terion-name/terrarium-dhi-postgres:17.9-alpine3.22-fips`);
    expect(workflow).toContain(`digest: ${POSTGRES_DIGEST}`);
    expect(workflow.match(/arches: amd64,arm64/g)).toHaveLength(2);

    expect(script).toContain("skopeo inspect --raw");
    expect(script).toContain("skopeo copy --retry-times 3 --all --preserve-digests");
    expect(script).toContain("sha256sum");
    expect(script).toContain("target digest mismatch");
    expect(script).toContain('(.platform.os // "") == "linux"');
    expect(script).toContain('(.platform.architecture // "") == $arch');
  });

  test("keeps the mirror helper executable for GitHub Actions", () => {
    const mode = statSync(join(repoRoot, ".github/scripts/mirror-dhi-image.sh")).mode;

    expect(mode & 0o111).not.toBe(0);
  });
});
