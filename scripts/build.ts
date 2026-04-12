import { $ } from "bun";
import { mkdirSync } from "node:fs";

const bun = Bun.which("bun");
if (!bun) {
  throw new Error("bun binary not found in PATH");
}

mkdirSync("dist", { recursive: true });

await $`${bun} build --compile scripts/terrariumctl.ts --outfile dist/terrariumctl`;
