import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("Cockpit role", () => {
  test("removes root from Cockpit disallowed users because Terrarium uses root for host login", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/cockpit/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Allow root Cockpit login for Terrarium management");
    expect(tasks).toContain("path: /etc/cockpit/disallowed-users");
    expect(tasks).toContain('regexp: "^root$"');
    expect(tasks).toContain("state: absent");
  });

  test("configures Cockpit to trust the Traefik management origin", () => {
    const tasks = readFileSync(join(repoRoot, "ansible/roles/cockpit/tasks/main.yml"), "utf8");

    expect(tasks).toContain("Trust Traefik management origin in Cockpit");
    expect(tasks).toContain("Tell Cockpit to honor Traefik forwarded scheme");
    expect(tasks).toContain("path: /etc/cockpit/cockpit.conf");
    expect(tasks).toContain("option: Origins");
    expect(tasks).toContain('value: "https://{{ terrarium_manage_domain }} wss://{{ terrarium_manage_domain }}"');
    expect(tasks).toContain("option: ProtocolHeader");
    expect(tasks).toContain("value: X-Forwarded-Proto");
  });
});
