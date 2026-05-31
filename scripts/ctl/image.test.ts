import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImageCreatePlan } from "./image";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";
const repoRoot = join(import.meta.dir, "../..");

function writeFakeLxc(path: string): void {
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TERRARIUM_LXC_LOG"
if [ "$1" = "snapshot" ] || [ "$1" = "copy" ] || [ "$1" = "delete" ]; then
  exit 0
fi
if [ "$1" = "publish" ]; then
  printf 'publish reached\\n' >> "$TERRARIUM_LXC_LOG"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "show" ]; then
  case "$TERRARIUM_LXC_MODE" in
    show-fails)
      echo "cannot read config" >&2
      exit 17
      ;;
    bad-json)
      printf '{bad-json'
      exit 0
      ;;
    sticky-label)
      printf '{"config":{"user.proxy":"https://leaked.example.test:8443"},"devices":{}}\\n'
      exit 0
      ;;
    remove-fails)
      printf '{"config":{},"devices":{"public-http":{"type":"proxy"}}}\\n'
      exit 0
      ;;
    *)
      printf '{"config":{},"devices":{}}\\n'
      exit 0
      ;;
  esac
fi
if [ "$1" = "config" ] && [ "$2" = "unset" ]; then
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "device" ] && [ "$3" = "remove" ]; then
  if [ "$TERRARIUM_LXC_MODE" = "remove-fails" ]; then
    echo "cannot remove proxy device" >&2
    exit 18
  fi
  exit 0
fi
echo "unexpected lxc command: $*" >&2
exit 99
`,
    { mode: 0o755 }
  );
}

function runImageCreateWithFakeLxc(mode: string): { exitCode: number | null; stderr: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "terrarium-image-test-"));
  try {
    const fakeLxc = join(dir, "lxc");
    const log = join(dir, "lxc.log");
    writeFakeLxc(fakeLxc);
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", join(repoRoot, "scripts/terrariumctl.ts"), "image", "create", "web-01", "golden-web", "--live"],
      cwd: repoRoot,
      env: { ...process.env, TERRARIUM_LXC_BIN: fakeLxc, TERRARIUM_LXC_LOG: log, TERRARIUM_LXC_MODE: mode },
      stdout: "pipe",
      stderr: "pipe"
    });
    return {
      exitCode: result.exitCode,
      stderr: new TextDecoder().decode(result.stderr),
      log: readFileSync(log, "utf8")
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("terrariumctl image", () => {
  test("creates a temporary snapshot-backed sanitized image plan by default", () => {
    expect(buildImageCreatePlan("web-01", "golden-web", {}, { now: 123, pid: 456 })).toEqual({
      instance: "web-01",
      alias: "golden-web",
      source: "web-01/terrarium-golden-123",
      tempInstance: "terrarium-image-golden-web-456-123",
      snapshotToCreate: "terrarium-golden-123",
      publishArgs: [lxc, "publish", "terrarium-image-golden-web-456-123", "--alias", "golden-web"]
    });
  });

  test("can publish an existing snapshot or live instance", () => {
    expect(buildImageCreatePlan("web-01", "golden-web", { snapshot: "known-good", reuse: true }, { now: 123, pid: 456 })).toMatchObject({
      source: "web-01/known-good",
      publishArgs: [lxc, "publish", "terrarium-image-golden-web-456-123", "--alias", "golden-web", "--reuse"]
    });
    const livePlan = buildImageCreatePlan("web-01", "golden-web", { live: true }, { now: 123, pid: 456 });
    expect(livePlan).toMatchObject({ source: "web-01" });
    expect(livePlan).not.toHaveProperty("snapshotToCreate");
  });

  test("rejects ambiguous or missing image create inputs", () => {
    expect(() => buildImageCreatePlan("", "golden-web")).toThrow("instance is required");
    expect(() => buildImageCreatePlan("web-01", "")).toThrow("image alias is required");
    expect(() => buildImageCreatePlan("web-01", "golden-web", { snapshot: "known-good", live: true })).toThrow("use either --snapshot or --live");
  });

  test("fails closed when proxy sanitization cannot read image source config", () => {
    const result = runImageCreateWithFakeLxc("show-fails");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("command failed (17)");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when proxy sanitization cannot parse image source config", () => {
    const result = runImageCreateWithFakeLxc("bad-json");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to parse LXD config for temporary image source");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when inherited proxy config remains after sanitization", () => {
    const result = runImageCreateWithFakeLxc("sticky-label");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("still has user.proxy after sanitization");
    expect(result.log).not.toContain("publish reached");
  });

  test("fails closed when inherited proxy devices cannot be removed", () => {
    const result = runImageCreateWithFakeLxc("remove-fails");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("command failed (18)");
    expect(result.log).not.toContain("publish reached");
  });
});
