import { basename } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  bodyContainsAnyMarker,
  bodyContainsDenialText,
  bodyContainsHttpErrorText,
  browserScreenshotPath,
  formatDeniedTargetRouteFailure,
  isLoginOrOauthCallbackPlumbingPath,
  isTargetApplicationPage
} from "./browser";

describe("browser assertion helpers", () => {
  test("recognizes denial text without treating a successful fixture body as denied", () => {
    expect(bodyContainsDenialText("403 Forbidden")).toBe(true);
    expect(bodyContainsDenialText("Access denied for this user")).toBe(true);
    expect(bodyContainsDenialText("terrarium-proxy-ok")).toBe(false);
  });

  test("recognizes user-facing error pages and expected UI markers", () => {
    expect(bodyContainsHttpErrorText("502 Bad Gateway")).toBe(true);
    expect(bodyContainsHttpErrorText("Cockpit\nUsername\nPassword")).toBe(false);
    expect(bodyContainsAnyMarker("Traefik Dashboard", ["Traefik", "Routers"])).toBe(true);
    expect(bodyContainsAnyMarker("blank page", ["Traefik", "Routers"])).toBe(false);
  });

  test("keeps oauth and login plumbing separate from target application pages", () => {
    expect(isLoginOrOauthCallbackPlumbingPath("/oauth2/route/grouped/callback")).toBe(true);
    expect(isLoginOrOauthCallbackPlumbingPath("/oauth2/callback")).toBe(true);
    expect(isLoginOrOauthCallbackPlumbingPath("/oidc/callback")).toBe(true);
    expect(isLoginOrOauthCallbackPlumbingPath("/ui/v2/login/password")).toBe(true);
    expect(isLoginOrOauthCallbackPlumbingPath("/protected")).toBe(false);

    expect(isTargetApplicationPage("https://app.example.test/oauth2/route/grouped/callback?code=123", "app.example.test")).toBe(false);
    expect(isTargetApplicationPage("https://app.example.test/protected", "app.example.test")).toBe(true);
    expect(isTargetApplicationPage("https://auth.example.test/ui/v2/login/password", "app.example.test")).toBe(false);
  });

  test("makes browser artifact names distinct by URL, expectation, user, and outcome", () => {
    const allowPath = browserScreenshotPath("/tmp/out", "https://app.example.test/protected", "allowed@example.test", "allow", "success");
    const denyPath = browserScreenshotPath("/tmp/out", "https://app.example.test/protected", "denied@example.test", "deny", "success");
    const denyFailurePath = browserScreenshotPath("/tmp/out", "https://app.example.test/protected", "denied@example.test", "deny", "failure");

    expect(basename(allowPath)).toBe("https-app-example-test-protected-allow-allowed-example-test-success.png");
    expect(basename(denyPath)).toBe("https-app-example-test-protected-deny-denied-example-test-success.png");
    expect(denyFailurePath).not.toBe(denyPath);
    expect(new Set([allowPath, denyPath, denyFailurePath]).size).toBe(3);
  });

  test("formats denied-route target failures with final URL and body snippet", () => {
    const message = formatDeniedTargetRouteFailure("https://app.example.test/protected", "terrarium-proxy-ok\nfixture reached");

    expect(message).toContain("browser reached the target host without denial text");
    expect(message).toContain("final url: https://app.example.test/protected");
    expect(message).toContain("terrarium-proxy-ok");
  });
});
