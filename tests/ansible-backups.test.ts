import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("backup role", () => {
  test("syncoid owns the configured replica mirror", () => {
    const service = readFileSync(join(repoRoot, "ansible/roles/backups/templates/terrarium-syncoid.service.j2"), "utf8");
    expect(service).toContain("ExecStart=/usr/sbin/syncoid");
    expect(service).toContain("--recursive");
    expect(service).toContain("--force-delete");
    expect(service).toContain("{{ terrarium_lxd_pool_name }}/containers");
    expect(service).toContain("{{ terrarium_syncoid_target }}:{{ terrarium_syncoid_target_dataset }}");
  });
});
