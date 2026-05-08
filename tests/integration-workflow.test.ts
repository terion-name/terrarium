import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const repoRoot = join(import.meta.dir, "..");

function workflow(name: string): Record<string, any> {
  return YAML.parse(readFileSync(join(repoRoot, ".github/workflows", name), "utf8"));
}

describe("integration workflows", () => {
  test("full integration runs smoke and post-smoke as independent slices", () => {
    const full = workflow("integration-full.yml");
    const smoke = full.jobs.smoke;
    const postSmoke = full.jobs.post_smoke;

    expect(smoke).toBeDefined();
    expect(postSmoke).toBeDefined();
    expect(smoke.needs).toBeUndefined();
    expect(postSmoke.needs).toBeUndefined();
    expect(smoke.if).toBe("${{ inputs.only == '' || inputs.only == 'smoke' }}");
    expect(postSmoke.if).toBe("${{ inputs.only == '' || inputs.only == 'full' }}");
    expect(smoke.steps.at(-1).run).toContain("bun run tests/integration/index.ts --suite smoke");
    expect(postSmoke.steps.at(-1).run).toContain("bun run tests/integration/index.ts --suite full --only full");
  });

  test("parallel integration slices use isolated resources and SSH keys", () => {
    const full = workflow("integration-full.yml");
    const standaloneSmoke = workflow("integration-smoke.yml");
    const fullSmoke = full.jobs.smoke;
    const postSmoke = full.jobs.post_smoke;
    const smoke = standaloneSmoke.jobs.smoke;

    expect(fullSmoke.env.TERRARIUM_INTEGRATION_SLUG).toBe("gha-${{ github.run_id }}-${{ github.run_attempt }}-smoke");
    expect(postSmoke.env.TERRARIUM_INTEGRATION_SLUG).toBe("gha-${{ github.run_id }}-${{ github.run_attempt }}-post-smoke");
    expect(fullSmoke.env.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN).toBe(
      "${{ vars.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN || 'nip.io' }}"
    );
    expect(postSmoke.env.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN).toBe(
      "${{ vars.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN || 'nip.io' }}"
    );
    expect(fullSmoke.env.TERRARIUM_INTEGRATION_OUTPUT_DIR).toBe("${{ github.workspace }}/tests/integration/output/smoke");
    expect(postSmoke.env.TERRARIUM_INTEGRATION_OUTPUT_DIR).toBe("${{ github.workspace }}/tests/integration/output/post-smoke");
    expect(fullSmoke.concurrency.group).toBe("terrarium-integration-${{ github.workflow }}-${{ github.ref }}-smoke");
    expect(postSmoke.concurrency.group).toBe("terrarium-integration-${{ github.workflow }}-${{ github.ref }}-post-smoke");

    expect(smoke.env.TERRARIUM_INTEGRATION_SLUG).toBe("gha-${{ github.run_id }}-${{ github.run_attempt }}-smoke");
    expect(smoke.env.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN).toBe("${{ vars.TERRARIUM_INTEGRATION_IP_DNS_DOMAIN || 'nip.io' }}");
    expect(smoke.concurrency.group).toBe("terrarium-integration-${{ github.workflow }}-${{ github.ref }}-smoke");

    for (const job of [fullSmoke, postSmoke, smoke]) {
      const keygenStep = job.steps.find((step: { name?: string }) => step.name === "Generate integration SSH key");
      expect(keygenStep?.run).toContain("ssh-keygen -t ed25519");
      expect(keygenStep?.run).toContain("HCLOUD_SSH_PRIVATE_KEY_FILE=");
      expect(keygenStep?.run).toContain("HCLOUD_SSH_PUBLIC_KEY_FILE=");
    }
  });
});
