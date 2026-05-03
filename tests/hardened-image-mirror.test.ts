import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = join(import.meta.dir, "..");

const OAUTH2_PROXY_DIGEST = "sha256:8f4e89762735e7ec7c3f1bbdd5da4dcd55358db8c3278bfbc2e46a7f86ab7d9e";
const OAUTH2_PROXY_MIRROR_DIGEST = "sha256:c5ec2ff7b486e72e7e6868efdc4c058f6280dba2ea472751c639d7b0e2bd43de";
const POSTGRES_DIGEST = "sha256:e8327d2f17677e94b5337a8bde47092d841bb10b718a2f77d4cd8a913b31f0e6";

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
    expect(workflow).toContain(`source_digest: ${OAUTH2_PROXY_DIGEST}`);
    expect(workflow).toContain(`target_digest: ${OAUTH2_PROXY_MIRROR_DIGEST}`);
    expect(workflow).toContain(`dhi.io/postgres@${POSTGRES_DIGEST}`);
    expect(workflow).not.toContain("17.9-alpine3.22-fips");
    expect(workflow).toContain(`ghcr.io/terion-name/terrarium-dhi-postgres:17.9-alpine3.22`);
    expect(workflow).toContain(`source_digest: ${POSTGRES_DIGEST}`);
    expect(workflow.match(/target_digest: auto/g)).toHaveLength(1);
    expect(workflow.match(/arches: amd64,arm64/g)).toHaveLength(2);

    expect(script).toContain("skopeo inspect --raw");
    expect(script).toContain("skopeo copy --retry-times 3 --all");
    expect(script).not.toContain("--preserve-digests");
    expect(script).toContain("sha256sum");
    expect(script).toContain("target digest mismatch");
    expect(script).toContain("source_arch_digest");
    expect(script).toContain("target_arch_digest");
    expect(script).toContain("platform manifests match source");
    expect(script).toContain('(.platform.os // "") == "linux"');
    expect(script).toContain('(.platform.architecture // "") == $arch');
  });

  test("keeps the mirror helper executable for GitHub Actions", () => {
    const mode = statSync(join(repoRoot, ".github/scripts/mirror-dhi-image.sh")).mode;

    expect(mode & 0o111).not.toBe(0);
  });
});
