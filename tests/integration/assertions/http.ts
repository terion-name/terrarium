import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllowFailure } from "../lib/process";

type HttpAssertionOptions = {
  resolveIp?: string;
  timeoutMs?: number;
};

function curlResolveArgs(url: string, resolveIp?: string): string[] {
  if (!resolveIp) {
    return [];
  }
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return ["--resolve", `${parsed.hostname}:${port}:${resolveIp}`];
}

export function parseCurlHttpBodyResult(stdout: string, body: string): { status: number; body: string } {
  const statusText = stdout.trim();
  const status = Number(statusText);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error(`curl did not return a valid final HTTP status: ${statusText || "<empty>"}`);
  }
  return { status, body };
}

/** Polls an HTTP endpoint until it returns one of the expected status codes. */
export async function waitForHttpStatus(url: string, expectedStatuses: number[], timeoutMs = 180000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: Response | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      lastResponse = response;
      if (expectedStatuses.includes(response.status)) {
        return response;
      }
    } catch {
      // Ignore transient DNS/TLS startup errors while services converge.
    }
    await Bun.sleep(5000);
  }
  throw new Error(`timed out waiting for ${url} to return one of [${expectedStatuses.join(", ")}], last status: ${lastResponse?.status ?? "none"}`);
}

async function readHttpsBody(url: string, resolveIp?: string): Promise<{ status: number; body: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "terrarium-http-"));
  const bodyPath = join(tempDir, "body");
  try {
    const result = await runAllowFailure([
      "curl",
      "-4",
      "-k",
      "-sS",
      "-L",
      "-o",
      bodyPath,
      "-w",
      "%{http_code}",
      "--max-time",
      "20",
      ...curlResolveArgs(url, resolveIp),
      url
    ]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `failed to fetch ${url}`);
    }

    const body = await readFile(bodyPath, "utf8");
    return parseCurlHttpBodyResult(result.stdout, body);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Polls an HTTPS endpoint with certificate verification disabled until it returns an expected status. */
export async function waitForHttpStatusInsecure(
  url: string,
  expectedStatuses: number[],
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<number> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : timeoutMsOrOptions.timeoutMs ?? 180000;
  const resolveIp = typeof timeoutMsOrOptions === "number" ? undefined : timeoutMsOrOptions.resolveIp;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const result = await runAllowFailure([
      "curl",
      "-4",
      "-k",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      "20",
      ...curlResolveArgs(url, resolveIp),
      url
    ]);
    const status = (result.stdout || "").trim();
    lastStatus = status || lastStatus;

    if (result.exitCode === 0) {
      const numericStatus = Number(status);
      if (expectedStatuses.includes(numericStatus)) {
        return numericStatus;
      }
    }

    await Bun.sleep(5000);
  }

  throw new Error(`timed out waiting for ${url} to return one of [${expectedStatuses.join(", ")}], last status: ${lastStatus || "none"}`);
}

/** Polls an endpoint until its response body contains the expected text. */
export async function expectHttpBodyContains(
  url: string,
  needle: string,
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<void> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : timeoutMsOrOptions.timeoutMs ?? 180000;
  const resolveIp = typeof timeoutMsOrOptions === "number" ? undefined : timeoutMsOrOptions.resolveIp;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "none";
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      if (url.startsWith("https://")) {
        const { status, body } = await readHttpsBody(url, resolveIp);
        lastStatus = String(status || 0);
        lastBody = body;
        if (body.includes(needle)) {
          return;
        }
      } else {
        const response = await fetch(url, { redirect: "follow" });
        const body = await response.text();
        lastStatus = String(response.status);
        lastBody = body;
        if (body.includes(needle)) {
          return;
        }
      }
    } catch (error) {
      lastBody = String(error);
    }

    await Bun.sleep(5000);
  }

  const bodySnippet = lastBody.replace(/\s+/g, " ").trim().slice(0, 400);
  throw new Error(`expected ${url} body to include "${needle}" within ${timeoutMs}ms; last status=${lastStatus}; last body=${bodySnippet || "<empty>"}`);
}
