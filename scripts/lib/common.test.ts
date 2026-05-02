import { describe, expect, test } from "bun:test";
import { runText } from "./common";

describe("command runner", () => {
  test("passes stdin to subprocesses", async () => {
    await expect(runText(["cat"], "test", { stdin: "terrarium-stdin" })).resolves.toBe("terrarium-stdin");
  });
});
