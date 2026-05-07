import { describe, expect, test } from "bun:test";
import { assertSafeLxdApiRootResponse, waitForLxdApiRootResponse } from "./integration/scenarios/common";
import type { HttpsResponse } from "./integration/assertions/http";

function response(status: number, body = "", headers = ""): HttpsResponse {
  return { status, body, headers };
}

const lxdRootBody = JSON.stringify({
  metadata: {
    api_extensions: ["oidc"],
    auth: "untrusted"
  }
});

describe("LXD API public probe", () => {
  test("accepts unauthenticated LXD JSON when it is not trusted", () => {
    expect(() => assertSafeLxdApiRootResponse(response(200, lxdRootBody), "lxd.example.test", "auth.example.test")).not.toThrow();
  });

  test("rejects trusted anonymous LXD JSON", () => {
    const body = JSON.stringify({ metadata: { api_extensions: [], auth: "trusted" } });

    expect(() => assertSafeLxdApiRootResponse(response(200, body), "lxd.example.test", "auth.example.test")).toThrow("trusted anonymous");
  });

  test("accepts expected OIDC challenges without following interactive redirects", () => {
    expect(() =>
      assertSafeLxdApiRootResponse(response(302, "", "HTTP/2 302\r\nlocation: /oidc/login\r\n"), "lxd.example.test", "auth.example.test")
    ).not.toThrow();
    expect(() =>
      assertSafeLxdApiRootResponse(
        response(303, "", "HTTP/2 303\r\nlocation: https://auth.example.test/oauth/v2/authorize\r\n"),
        "lxd.example.test",
        "auth.example.test"
      )
    ).not.toThrow();
    expect(() => assertSafeLxdApiRootResponse(response(403), "lxd.example.test", "auth.example.test")).not.toThrow();
  });

  test("rejects redirects away from the managed LXD and auth hosts", () => {
    expect(() =>
      assertSafeLxdApiRootResponse(response(302, "", "location: https://evil.example.test/login\r\n"), "lxd.example.test", "auth.example.test")
    ).toThrow("unexpected location");
  });

  test("polls through transient HTTP responses until the LXD API is safe", async () => {
    const responses = [response(503, "service unavailable"), response(403)];
    const seenUrls: string[] = [];

    const result = await waitForLxdApiRootResponse(
      {
        domains: {
          lxd: "lxd.example.test",
          auth: "auth.example.test"
        },
        server: {
          ipv4: "203.0.113.10"
        }
      } as never,
      {
        timeoutMs: 1000,
        sleep: async () => undefined,
        readResponse: async (url) => {
          seenUrls.push(url);
          const nextResponse = responses.shift();
          if (!nextResponse) {
            throw new Error("unexpected extra poll");
          }
          return nextResponse;
        }
      }
    );

    expect(result.status).toBe(403);
    expect(seenUrls).toEqual(["https://lxd.example.test/1.0", "https://lxd.example.test/1.0"]);
  });
});
