import { describe, expect, test } from "bun:test";
import { run } from "./process";

describe("integration process helpers", () => {
  test("renders stdout and stderr for failed commands", async () => {
    await expect(run(["bash", "-lc", "echo useful-stdout; echo useful-stderr >&2; exit 7"])).rejects.toThrow(
      /command failed \(7\): bash -lc.*stdout:\nuseful-stdout.*stderr:\nuseful-stderr/s
    );
  });
});
