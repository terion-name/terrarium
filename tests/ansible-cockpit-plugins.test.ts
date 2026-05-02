import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("Cockpit plugin fallback builds", () => {
  test("pin upstream bootstrap scripts to their declared Yarn releases", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/cockpit_plugins/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Pin cockpit-zfs source bootstrap to the declared Yarn release");
    expect(tasks).toContain("Pin cockpit-S3ObjectBroswer source bootstrap to the declared Yarn release");
    expect(tasks).toContain("(.packageManager // \"yarn@4.6.0\")");
    expect(tasks).toContain("(.packageManager // \"yarn@4.12.0\")");
    expect(tasks).toContain("sed -i \"s/yarn set version stable/yarn set version ${yarn_version}/\" bootstrap.sh");
  });
});
