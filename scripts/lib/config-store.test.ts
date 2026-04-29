import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportClusterStoreToConfigFile,
  importConfigFileToClusterStore,
  readConfigDocument,
  writeConfigDocument
} from "./config-store";

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function fakeLxc(tempDir: string): string {
  const binary = join(tempDir, "lxc");
  const store = join(tempDir, "cluster-value");
  writeFileSync(
    binary,
    `#!/usr/bin/env bash
set -euo pipefail
store=${JSON.stringify(store)}
if [[ "$1 $2 $3" == "project show terrarium-system" ]]; then
  exit 0
fi
if [[ "$1 $2 $3 $4" == "project get terrarium-system user.terrarium.config_b64" ]]; then
  [[ -f "$store" ]] && cat "$store"
  exit 0
fi
if [[ "$1 $2 $3 $4" == "project set terrarium-system user.terrarium.config_b64" ]]; then
  printf '%s' "$5" > "$store"
  exit 0
fi
echo "unexpected lxc args: $*" >&2
exit 1
`
  );
  chmodSync(binary, 0o755);
  return binary;
}

describe("Terrarium config store", () => {
  test("auto mode keeps non-canonical paths file-backed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-store-"));
    try {
      const configPath = join(tempDir, "test-config.yaml");
      writeFileSync(configPath, "terrarium_public_ip: 203.0.113.10\n", "utf8");

      withEnv(
        {
          TERRARIUM_CONFIG_BACKEND: "auto",
          TERRARIUM_CONFIG_PATH: join(tempDir, "canonical.yaml"),
          TERRARIUM_LXC_BIN: join(tempDir, "missing-lxc")
        },
        () => {
          expect(readConfigDocument(configPath, "test")).toBe("terrarium_public_ip: 203.0.113.10\n");
        }
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("imports the canonical file into the LXD dqlite-backed project store", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-store-"));
    try {
      const configPath = join(tempDir, "config.yaml");
      const lxc = fakeLxc(tempDir);
      writeFileSync(configPath, "terrarium_root_domain: example.test\n", "utf8");

      withEnv(
        {
          TERRARIUM_CONFIG_BACKEND: "lxd-dqlite",
          TERRARIUM_CONFIG_PATH: configPath,
          TERRARIUM_LXC_BIN: lxc
        },
        () => {
          importConfigFileToClusterStore(configPath, "test");
          expect(readConfigDocument(configPath, "test")).toBe("terrarium_root_domain: example.test\n");
        }
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("writes and exports canonical config through the cluster store", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "terrarium-config-store-"));
    try {
      const configPath = join(tempDir, "config.yaml");
      const lxc = fakeLxc(tempDir);

      withEnv(
        {
          TERRARIUM_CONFIG_BACKEND: "lxd-dqlite",
          TERRARIUM_CONFIG_PATH: configPath,
          TERRARIUM_LXC_BIN: lxc
        },
        () => {
          writeConfigDocument(configPath, "terrarium_email: ops@example.test\n", { requireClusterStore: true });
          writeFileSync(configPath, "stale: true\n", "utf8");
          expect(exportClusterStoreToConfigFile(configPath, "test")).toBe(true);
          expect(readFileSync(configPath, "utf8")).toBe("terrarium_email: ops@example.test\n");
        }
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
