import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("full integration scenario resource shape", () => {
  test("registers smoke and full-only coverage as separate scenarios", () => {
    const index = readFileSync(join(repoRoot, "tests/integration/index.ts"), "utf8");
    const full = readFileSync(join(repoRoot, "tests/integration/scenarios/full.ts"), "utf8");
    const smokeScenarioIndex = index.indexOf('context.withScenario("smoke"');
    const fullScenarioIndex = index.indexOf('context.withScenario("full"');

    expect(smokeScenarioIndex).toBeGreaterThan(0);
    expect(fullScenarioIndex).toBeGreaterThan(smokeScenarioIndex);
    expect(full).not.toContain("runSmokeSuite");
  });

  test("releases non-cluster hosts before provisioning cluster members", () => {
    const full = readFileSync(join(repoRoot, "tests/integration/scenarios/full.ts"), "utf8");
    const releaseFileHostIndex = full.indexOf("await context.releaseHetznerHost(fileHost);");
    const releasePartitionHostIndex = full.indexOf("await context.releaseHetznerHost(partitionHost);");
    const clusterIndex = full.indexOf("await verifyTerrariumCluster(context, sshKeyId);");

    expect(releaseFileHostIndex).toBeGreaterThan(0);
    expect(releasePartitionHostIndex).toBeGreaterThan(releaseFileHostIndex);
    expect(clusterIndex).toBeGreaterThan(releasePartitionHostIndex);
  });

  test("checks CIFS container mounts before provisioning partition-mode host", () => {
    const full = readFileSync(join(repoRoot, "tests/integration/scenarios/full.ts"), "utf8");
    const cifsIndex = full.indexOf("await verifySharedCifsStorage(context, fileSsh);");
    const partitionIndex = full.indexOf('partitionHost = await provisionHost(context, { label: "full-partition"');

    expect(cifsIndex).toBeGreaterThan(0);
    expect(partitionIndex).toBeGreaterThan(cifsIndex);
  });
});
