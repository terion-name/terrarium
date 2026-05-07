import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("docs config", () => {
  test("rejects protocol-relative docs base values", () => {
    const source = readRepoFile("docs/.vitepress/config.mts");

    expect(source).toContain('raw.startsWith("//")');
    expect(source).toContain("TERRARIUM_DOCS_BASE must be a root-relative path");
  });

  test("documents the non-root container workflow and trm exec wrapper", () => {
    const security = readRepoFile("docs/security.md");
    const reference = readRepoFile("docs/reference/terrariumctl.md");
    const guidePaths = [
      "docs/guides/openclaw.md",
      "docs/guides/hermes.md",
      "docs/guides/vscode.md",
      "docs/guides/compose.md",
      "docs/guides/coolify.md"
    ];
    const guides = guidePaths.map((path) => readRepoFile(path)).join("\n");
    const sharedData = readRepoFile("docs/getting-started/shared-data-between-containers.md");

    expect(security).toContain("base `default`, `terrarium`, or `strict` profiles");
    expect(security).toContain("lxc launch images:ubuntu/24.04 devbox --profile default --profile dev");
    expect(security).toContain("trm exec devbox");
    expect(security).toContain("day-to-day work should happen under `/home/terrarium`");

    expect(reference).toContain("| `terrariumctl exec` |");
    expect(reference).toContain("trm exec my-stack");
    expect(reference).toContain("trm exec my-stack --root");

    expect(guides).toContain("--profile default --profile dev");
    expect(guides).toContain("trm exec");
    expect(guides).not.toContain("lxc exec openclaw --user 1000");
    expect(guides).not.toContain("lxc exec hermes --user 1000");
    expect(guides).not.toContain("lxc exec devbox --user 1000");
    expect(guides).not.toContain("lxc exec my-stack --user 1000");
    expect(sharedData).toContain("/home/terrarium/.codex");
    expect(sharedData).not.toContain("/root/.codex");
  });

  test("documents deployment tool server-user constraints accurately", () => {
    const dokploy = readRepoFile("docs/guides/dokploy.md");
    const coolify = readRepoFile("docs/guides/coolify.md");

    expect(dokploy).toContain("Dokploy currently requires root access for remote deployment servers");
    expect(dokploy).toContain("trm exec apps-a --root");
    expect(dokploy).toContain("PermitRootLogin .*/PermitRootLogin prohibit-password");
    expect(dokploy).toContain("user `root`");
    expect(dokploy).not.toContain("In Dokploy, go to **Remote Servers** -> **Add Server**. Enter the private IP address, the user `terrarium`");

    expect(coolify).toContain("Coolify supports non-root server users");
    expect(coolify).toContain("mark this as experimental");
    expect(coolify).toContain("lxc launch images:ubuntu/24.04 apps-server-1 --profile default --profile dev");
    expect(coolify).toContain("user `terrarium`");
    expect(coolify).toContain("PermitRootLogin .*/PermitRootLogin no");
  });
});
