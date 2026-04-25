import { describe, expect, test } from "bun:test";
import { parseCurlHttpBodyResult } from "./http";

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
});
