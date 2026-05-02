import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IntegrationLogger } from "./lib/logger";
import { IntegrationResourceGuard } from "./resource-guard";
import { CleanupManifestStore } from "./resources";

const logger = {
  path: "",
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  }
} as unknown as IntegrationLogger;

function createStore(): { dir: string; store: CleanupManifestStore } {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-resource-guard-"));
  return {
    dir,
    store: new CleanupManifestStore(join(dir, "resources.json"), "guard-test")
  };
}

describe("integration resource guard", () => {
  test("does not keep successful keep-on-failure runs alive by itself", () => {
    const source = readFileSync(join(import.meta.dir, "resource-guard.ts"), "utf8");

    expect(source).toContain(".unref?.()");
  });

  test("fails fast when a tracked Hetzner server disappears", async () => {
    const { dir, store } = createStore();
    try {
      store.recordHetznerServer({ id: 42, name: "terrarium-guard-test-primary", label: "primary", ipv4: "192.0.2.42" });
      const fatalErrors: Error[] = [];
      const guard = new IntegrationResourceGuard({
        resources: store,
        logger,
        hetzner: {
          async serverExists() {
            return false;
          }
        },
        onFatal(error) {
          fatalErrors.push(error);
        }
      });

      await guard.checkOnce();

      expect(fatalErrors).toHaveLength(1);
      expect(fatalErrors[0]?.message).toContain("primary/terrarium-guard-test-primary (42)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores intentional server release while the delete is in progress", async () => {
    const { dir, store } = createStore();
    try {
      store.recordHetznerServer({ id: 42, name: "terrarium-guard-test-primary", label: "primary", ipv4: "192.0.2.42" });
      const fatalErrors: Error[] = [];
      const guard = new IntegrationResourceGuard({
        resources: store,
        logger,
        hetzner: {
          async serverExists() {
            return false;
          }
        },
        onFatal(error) {
          fatalErrors.push(error);
        }
      });

      await guard.allowExpectedServerDeletion(42, async () => {
        await guard.checkOnce();
      });

      expect(fatalErrors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
