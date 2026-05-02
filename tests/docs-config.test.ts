import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

describe("docs config", () => {
  test("rejects protocol-relative docs base values", () => {
    const source = readFileSync(join(repoRoot, "docs/.vitepress/config.mts"), "utf8");

    expect(source).toContain('raw.startsWith("//")');
    expect(source).toContain("TERRARIUM_DOCS_BASE must be a root-relative path");
  });
});
