import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("full integration scenario resource shape", () => {
  test("releases non-cluster hosts before provisioning cluster members", () => {
    const full = readFileSync(join(repoRoot, "tests/integration/scenarios/full.ts"), "utf8");
    const releaseFileHostIndex = full.indexOf("await context.releaseHetznerHost(fileHost);");
    const releasePartitionHostIndex = full.indexOf("await context.releaseHetznerHost(partitionHost);");
    const clusterIndex = full.indexOf("await verifyTerrariumCluster(context, sshKeyId);");

    expect(releaseFileHostIndex).toBeGreaterThan(0);
    expect(releasePartitionHostIndex).toBeGreaterThan(releaseFileHostIndex);
    expect(clusterIndex).toBeGreaterThan(releasePartitionHostIndex);
  });
});
