import { describe, expect, test } from "bun:test";
import { assertSafeLxdApiRootResponse } from "./integration/scenarios/common";
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
});
