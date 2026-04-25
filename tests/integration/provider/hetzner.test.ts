import { afterEach, describe, expect, test } from "bun:test";
import type { IntegrationLogger } from "../lib/logger";
import type { IntegrationConfig } from "../types";
import { HetznerCloudProvider } from "./hetzner";

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

type FetchCall = {
  input: Parameters<typeof fetch>[0];
  init?: Parameters<typeof fetch>[1];
};

const logger = {
  path: "",
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  }
} as unknown as IntegrationLogger;

function createProvider(): HetznerCloudProvider {
  return new HetznerCloudProvider(
    {
      hcloudToken: "token-1",
      hcloudLocation: "fsn1"
    } as IntegrationConfig,
    logger
  );
}

function installFetchMock(responses: Response[]): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`unexpected fetch call ${String(input)}`);
    }
    return response;
  }) as typeof fetch;
  return calls;
}

function callPath(call: FetchCall): string {
  return new URL(String(call.input)).pathname;
}

function setSleepMock(handler: (ms: number) => Promise<void>): void {
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = handler as typeof Bun.sleep;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  (Bun as unknown as { sleep: typeof Bun.sleep }).sleep = originalSleep;
});

describe("Hetzner Cloud provider cleanup", () => {
  test("deleteVolume retries transient locked responses", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response(JSON.stringify({ error: { code: "locked" } }), { status: 423 }),
      new Response(null, { status: 204 })
    ]);

    await createProvider().deleteVolume(42);

    expect(calls.map(callPath)).toEqual(["/v1/volumes/42", "/v1/volumes/42"]);
    expect(calls.map((call) => call.init?.method)).toEqual(["DELETE", "DELETE"]);
    expect(sleeps).toEqual([5000]);
  });

  test("deleteVolume detaches attached volumes before retrying deletion", async () => {
    const sleeps: number[] = [];
    setSleepMock(async (ms) => {
      sleeps.push(ms);
    });
    const calls = installFetchMock([
      new Response("volume is attached", { status: 422 }),
      new Response(JSON.stringify({ volume: { id: 42, server: 100 } }), { status: 200 }),
      new Response(JSON.stringify({ action: { id: 77, status: "running" } }), { status: 201 }),
      new Response(JSON.stringify({ action: { id: 77, status: "success" } }), { status: 200 }),
      new Response(null, { status: 204 })
    ]);

    await createProvider().deleteVolume(42);

    expect(calls.map(callPath)).toEqual([
      "/v1/volumes/42",
      "/v1/volumes/42",
      "/v1/volumes/42/actions/detach",
      "/v1/actions/77",
      "/v1/volumes/42"
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(["DELETE", "GET", "POST", "GET", "DELETE"]);
    expect(sleeps).toEqual([5000]);
  });
});
