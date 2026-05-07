import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";

const repoRoot = join(import.meta.dir, "..");

describe("release workflow", () => {
  test("tag releases do not also trigger the generic validate workflow", () => {
    const validate = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/validate.yml"), "utf8"));
    const release = YAML.parse(readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8"));

    expect(validate.on.push.branches).toEqual(["**"]);
    expect(validate.on.push.tags).toBeUndefined();
    expect(release.on.push.tags).toEqual(["*"]);
  });

  test("validate workflow retries transient Ansible Galaxy collection failures", () => {
    const source = readFileSync(join(repoRoot, ".github/workflows/validate.yml"), "utf8");

    expect(source).toContain("for attempt in 1 2 3 4; do");
    expect(source).toContain("ansible-galaxy collection install -r requirements.yml");
    expect(source).toContain('if [ "$attempt" -eq 4 ]; then');
    expect(source).toContain("sleep $((attempt * 5))");
  });

  test("validates release tags before preflight and publishing", () => {
    const source = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const workflow = YAML.parse(source);

    expect(workflow.jobs.release_tag).toBeDefined();
    expect(source).toContain('[[ "${RELEASE_TAG}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]');
    expect(source).toContain("Release tags may only contain letters, numbers, '.', '_', and '-'");
    expect(source).toContain("printf 'value=%s\\n' \"${RELEASE_TAG}\" >> \"${GITHUB_OUTPUT}\"");
    expect(workflow.jobs.integration_preflight.needs).toBe("release_tag");
    expect(workflow.jobs.build.needs).toContain("release_tag");
    expect(workflow.jobs.publish.needs).toContain("release_tag");
    expect(source).toContain("TERRARIUM_VERSION: ${{ needs.release_tag.outputs.value }}");
    expect(source).toContain("bun scripts/build.ts");
    expect(source).toContain("tag_name: ${{ needs.release_tag.outputs.value }}");
  });

  test("release preflight does not require removed DuckDNS secrets", () => {
    const release = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const fullIntegration = readFileSync(join(repoRoot, ".github/workflows/integration-full.yml"), "utf8");
    const smokeIntegration = readFileSync(join(repoRoot, ".github/workflows/integration-smoke.yml"), "utf8");

    expect(release).toContain("uses: ./.github/workflows/integration-full.yml");
    expect(fullIntegration).not.toContain("DUCKDNS_DOMAIN");
    expect(fullIntegration).not.toContain("DUCKDNS_TOKEN");
    expect(smokeIntegration).not.toContain("DUCKDNS_DOMAIN");
    expect(smokeIntegration).not.toContain("DUCKDNS_TOKEN");
  });

  test("shell-quotes the embedded bootstrap ref instead of interpolating it through sed", () => {
    const source = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

    expect(source).toContain("shlex.quote(release_tag)");
    expect(source).toContain("EMBEDDED_BOOTSTRAP_REF={shlex.quote(release_tag)} # TERRARIUM_RELEASE_REF");
    expect(source).not.toContain('sed "s|^EMBEDDED_BOOTSTRAP_REF=\\"\\" # TERRARIUM_RELEASE_REF$|');
    expect(source).not.toContain('EMBEDDED_BOOTSTRAP_REF=\\"${RELEASE_TAG}\\"');
  });

  test("generated installer assignment treats shell metacharacters as data", () => {
    const dir = mkdtempSync(join(tmpdir(), "terrarium-release-workflow-"));
    const marker = join(dir, "pwned");
    const installer = join(dir, "install.sh");
    const payload = `v1.2.3";touch\${IFS}${marker};#`;

    try {
      const quote = spawnSync("python3", ["-c", "import os, shlex; print(shlex.quote(os.environ['RELEASE_TAG']))"], {
        env: { ...process.env, RELEASE_TAG: payload },
        encoding: "utf8"
      });
      expect(quote.status).toBe(0);

      writeFileSync(
        installer,
        [
          "#!/usr/bin/env bash",
          "set -Eeuo pipefail",
          `EMBEDDED_BOOTSTRAP_REF=${quote.stdout.trim()} # TERRARIUM_RELEASE_REF`,
          'printf "%s\\n" "${EMBEDDED_BOOTSTRAP_REF}"'
        ].join("\n")
      );

      const run = spawnSync("bash", [installer], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe(payload);
      expect(spawnSync("test", ["!", "-e", marker]).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plugin bundle releases cannot replace the latest Terrarium installer", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/cockpit-plugins.yml"), "utf8");
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(workflow.match(/make_latest: false/g)?.length).toBe(2);
    expect(installer).toContain("releases?per_page=50");
    expect(installer).toContain('TERRARIUM_ASSET="terrarium-linux-${arch}.zip"');
    expect(installer).toContain('any(item.get("name") == asset for item in release.get("assets", []))');
  });
});
