import { describe, expect, test } from "bun:test";
import { buildImageCreatePlan } from "./image";

const lxc = process.env.TERRARIUM_LXC_BIN ?? "/snap/bin/lxc";

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
});
