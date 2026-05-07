import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { CURL_PROCESS_TIMEOUT_MS, HTTP_FETCH_TIMEOUT_MS, curlTlsVerificationArgs, parseCurlHttpBodyResult } from "./http";

describe("HTTP assertion helpers", () => {
  test("uses curl's final status output instead of header-looking body content", () => {
    const body = [
      "HTTP/2 302",
      "location: https://auth.example.test/login",
      "",
      "HTTP/2 200",
      "",
      "terrarium-proxy-ok"
    ].join("\r\n");

    expect(parseCurlHttpBodyResult("200", body)).toEqual({
      status: 200,
      body
    });
  });

  test("rejects missing or non-status curl output", () => {
    expect(() => parseCurlHttpBodyResult("", "body")).toThrow("valid final HTTP status");
    expect(() => parseCurlHttpBodyResult("HTTP/2 302", "body")).toThrow("valid final HTTP status");
  });

  test("skips TLS verification for host-pinned integration probes unless explicitly disabled", () => {
    expect(curlTlsVerificationArgs({ resolveIp: "203.0.113.10" })).toEqual(["-k"]);
    expect(curlTlsVerificationArgs({ resolveIp: "203.0.113.10", insecure: false })).toEqual([]);
    expect(curlTlsVerificationArgs({ insecure: true })).toEqual(["-k"]);
    expect(curlTlsVerificationArgs({})).toEqual([]);
  });

  test("bounds every network attempt below the outer poll deadline", () => {
    const source = readFileSync(new URL("./http.ts", import.meta.url), "utf8");

    expect(HTTP_FETCH_TIMEOUT_MS).toBeLessThan(30000);
    expect(CURL_PROCESS_TIMEOUT_MS).toBeGreaterThan(HTTP_FETCH_TIMEOUT_MS);
    expect(source.match(/timeoutMs: CURL_PROCESS_TIMEOUT_MS/g)?.length).toBe(2);
    expect(source.match(/await fetchWithTimeout\(url/g)?.length).toBe(1);
    expect(source.match(/await fetchTextWithTimeout\(url/g)?.length).toBe(1);
    expect(source).toContain("...(options.followRedirects ? [\"-L\"] : [])");
  });
});
