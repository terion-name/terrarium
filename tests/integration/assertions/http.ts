import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAllowFailure } from "../lib/process";

type HttpAssertionOptions = {
  resolveIp?: string;
  timeoutMs?: number;
  insecure?: boolean;
};

type HttpsReadOptions = HttpAssertionOptions & {
  followRedirects?: boolean;
  headers?: string[];
};

export type HttpsResponse = {
  status: number;
  body: string;
  headers: string;
};

type JsonValidator = (value: unknown) => void;

export const HTTP_FETCH_TIMEOUT_MS = 20000;
export const CURL_PROCESS_TIMEOUT_MS = 30000;
const HTTP_POLL_INTERVAL_MS = 5000;

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

async function withFetchTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_FETCH_TIMEOUT_MS);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return await withFetchTimeout((signal) => fetch(url, { ...init, signal }));
}

async function fetchTextWithTimeout(url: string, init: RequestInit): Promise<{ response: Response; body: string }> {
  return await withFetchTimeout(async (signal) => {
    const response = await fetch(url, { ...init, signal });
    const body = await response.text();
    return { response, body };
  });
}

/** Polls an HTTP endpoint until it returns one of the expected status codes. */
export async function waitForHttpStatus(url: string, expectedStatuses: number[], timeoutMs = 180000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastResponse: Response | null = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, { redirect: "manual" });
      lastResponse = response;
      if (expectedStatuses.includes(response.status)) {
        return response;
      }
    } catch {
      // Ignore transient DNS/TLS startup errors while services converge.
    }
    await Bun.sleep(HTTP_POLL_INTERVAL_MS);
  }
  throw new Error(`timed out waiting for ${url} to return one of [${expectedStatuses.join(", ")}], last status: ${lastResponse?.status ?? "none"}`);
}

export async function readHttpsResponse(url: string, options: HttpsReadOptions = {}): Promise<HttpsResponse> {
  const tempDir = await mkdtemp(join(tmpdir(), "terrarium-http-"));
  const bodyPath = join(tempDir, "body");
  const headersPath = join(tempDir, "headers");
  try {
    const result = await runAllowFailure([
      "curl",
      "-4",
      "-sS",
      "--noproxy",
      "*",
      ...(options.followRedirects ? ["-L"] : []),
      ...((options.headers ?? []).flatMap((header) => ["-H", header])),
      "-D",
      headersPath,
      "-o",
      bodyPath,
      "-w",
      "%{http_code}",
      "--connect-timeout",
      "5",
      "--max-time",
      "20",
      ...(options.insecure ? ["-k"] : []),
      ...curlResolveArgs(url, options.resolveIp),
      url
    ], { timeoutMs: CURL_PROCESS_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `failed to fetch ${url}`);
    }

    const body = await readFile(bodyPath, "utf8");
    const headers = await readFile(headersPath, "utf8").catch(() => "");
    return { ...parseCurlHttpBodyResult(result.stdout, body), headers };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readHttpsBody(url: string, options: HttpsReadOptions = {}): Promise<{ status: number; body: string }> {
  const { status, body } = await readHttpsResponse(url, options);
  return { status, body };
}

/** Polls an HTTPS endpoint with certificate verification disabled until it returns an expected status. */
export async function waitForHttpStatusInsecure(
  url: string,
  expectedStatuses: number[],
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<number> {
  const options = typeof timeoutMsOrOptions === "number" ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
  return await waitForHttpStatusResolved(url, expectedStatuses, { ...options, insecure: true });
}

/** Polls an HTTP(S) endpoint with optional host resolution until it returns an expected status. */
export async function waitForHttpStatusResolved(
  url: string,
  expectedStatuses: number[],
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<number> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : timeoutMsOrOptions.timeoutMs ?? 180000;
  const resolveIp = typeof timeoutMsOrOptions === "number" ? undefined : timeoutMsOrOptions.resolveIp;
  const insecure = typeof timeoutMsOrOptions === "number" ? false : timeoutMsOrOptions.insecure ?? false;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let lastError = "";

  while (Date.now() < deadline) {
    const result = await runAllowFailure([
      "curl",
      "-4",
      "-sS",
      "--noproxy",
      "*",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--connect-timeout",
      "5",
      "--max-time",
      "20",
      ...(insecure ? ["-k"] : []),
      ...curlResolveArgs(url, resolveIp),
      url
    ], { timeoutMs: CURL_PROCESS_TIMEOUT_MS });
    const status = (result.stdout || "").trim();
    lastStatus = status || lastStatus;
    lastError = result.stderr.trim() || result.stdout.trim() || lastError;

    if (result.exitCode === 0) {
      const numericStatus = Number(status);
      if (expectedStatuses.includes(numericStatus)) {
        return numericStatus;
      }
    }

    await Bun.sleep(HTTP_POLL_INTERVAL_MS);
  }

  throw new Error(
    `timed out waiting for ${url} to return one of [${expectedStatuses.join(", ")}], last status: ${lastStatus || "none"}, last error: ${
      lastError || "none"
    }`
  );
}

/** Polls an endpoint until its response body contains the expected text. */
export async function expectHttpBodyContains(
  url: string,
  needle: string,
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<void> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : timeoutMsOrOptions.timeoutMs ?? 180000;
  const resolveIp = typeof timeoutMsOrOptions === "number" ? undefined : timeoutMsOrOptions.resolveIp;
  const insecure = typeof timeoutMsOrOptions === "number" ? false : timeoutMsOrOptions.insecure ?? false;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "none";
  let lastBody = "";

  while (Date.now() < deadline) {
    try {
      if (url.startsWith("https://")) {
        const { status, body } = await readHttpsBody(url, { resolveIp, insecure, followRedirects: true });
        lastStatus = String(status || 0);
        lastBody = body;
        if (body.includes(needle)) {
          return;
        }
      } else {
        const { response, body } = await fetchTextWithTimeout(url, { redirect: "follow" });
        lastStatus = String(response.status);
        lastBody = body;
        if (body.includes(needle)) {
          return;
        }
      }
    } catch (error) {
      lastBody = String(error);
    }

    await Bun.sleep(HTTP_POLL_INTERVAL_MS);
  }

  const bodySnippet = lastBody.replace(/\s+/g, " ").trim().slice(0, 400);
  throw new Error(`expected ${url} body to include "${needle}" within ${timeoutMs}ms; last status=${lastStatus}; last body=${bodySnippet || "<empty>"}`);
}

/** Polls an HTTPS endpoint until it returns JSON accepted by the validator. */
export async function expectHttpsJson(
  url: string,
  validate: JsonValidator,
  timeoutMsOrOptions: number | HttpAssertionOptions = 180000
): Promise<void> {
  const timeoutMs = typeof timeoutMsOrOptions === "number" ? timeoutMsOrOptions : timeoutMsOrOptions.timeoutMs ?? 180000;
  const resolveIp = typeof timeoutMsOrOptions === "number" ? undefined : timeoutMsOrOptions.resolveIp;
  const insecure = typeof timeoutMsOrOptions === "number" ? false : timeoutMsOrOptions.insecure ?? false;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "none";
  let lastBody = "";
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const { status, body } = await readHttpsBody(url, { resolveIp, insecure });
      lastStatus = String(status || 0);
      lastBody = body;

      if (status >= 200 && status < 300) {
        validate(JSON.parse(body) as unknown);
        return;
      }

      lastError = `unexpected HTTP status ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(HTTP_POLL_INTERVAL_MS);
  }

  const bodySnippet = lastBody.replace(/\s+/g, " ").trim().slice(0, 400);
  throw new Error(
    `expected ${url} to return valid JSON within ${timeoutMs}ms; last status=${lastStatus}; last error=${lastError || "none"}; last body=${
      bodySnippet || "<empty>"
    }`
  );
}
