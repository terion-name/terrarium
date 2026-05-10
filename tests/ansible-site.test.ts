import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const repoRoot = join(import.meta.dir, "..");

describe("Ansible site playbook", () => {
  test("waits for unattended-upgrades dpkg locks before apt tasks fail", () => {
    const source = readFileSync(join(repoRoot, "ansible/site.yml"), "utf8");
    const [play] = YAML.parse(source);

    expect(play.module_defaults["ansible.builtin.apt"].lock_timeout).toBe(900);
  });
});
