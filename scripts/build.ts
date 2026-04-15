import { $ } from "bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const bun = Bun.which("bun") ?? process.execPath;
if (!bun) {
  throw new Error("bun binary not found in PATH");
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
const version = process.env.TERRARIUM_VERSION?.trim() || packageJson.version || "0.0.0-dev";
const splashTemplate = readFileSync("assets/splash.txt", "utf8").replace(/\r\n/g, "\n");

function renderSplash(template: string, currentVersion: string): string {
  const lines = template.split("\n");
  return lines
    .map((line) => {
      if (!line.includes("{{VERSION}}")) {
        return line;
      }
      if (!line.startsWith("║") || !line.endsWith("║")) {
        return line.replaceAll("{{VERSION}}", currentVersion);
      }
      const content = line.slice(1, -1).replaceAll("{{VERSION}}", currentVersion);
      const trimmed = content.trim();
      const innerWidth = line.length - 2;
      if (trimmed.length > innerWidth) {
        throw new Error(`splash version line is too long for width ${innerWidth}: ${trimmed}`);
      }
      const remaining = innerWidth - trimmed.length;
      const left = Math.floor(remaining / 2);
      const right = remaining - left;
      return `║${" ".repeat(left)}${trimmed}${" ".repeat(right)}║`;
    })
    .join("\n");
}

const splash = renderSplash(splashTemplate, version);

mkdirSync("scripts/generated", { recursive: true });
writeFileSync(
  "scripts/generated/build-info.ts",
  `export const TERRARIUM_VERSION = ${JSON.stringify(version)};\n\nexport const TERRARIUM_SPLASH = ${JSON.stringify(splash)};\n`
);

mkdirSync("dist", { recursive: true });

await $`${bun} build --compile scripts/terrariumctl.ts --outfile dist/terrariumctl`;
