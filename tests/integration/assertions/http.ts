import { runAllowFailure } from "../lib/process";

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

/** Polls an HTTPS endpoint with certificate verification disabled until it returns an expected status. */
export async function waitForHttpStatusInsecure(url: string, expectedStatuses: number[], timeoutMs = 180000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const result = await runAllowFailure(["curl", "-k", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", url]);
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

/** Fetches an endpoint and throws when the response body does not contain the expected text. */
export async function expectHttpBodyContains(url: string, needle: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  const body = await response.text();
  if (!body.includes(needle)) {
    throw new Error(`expected ${url} body to include "${needle}"`);
  }
}
