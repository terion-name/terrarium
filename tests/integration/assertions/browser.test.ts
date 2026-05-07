import { basename } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  bodyContainsAnyMarker,
  bodyContainsDenialText,
  bodyContainsHttpErrorText,
  browserScreenshotPath,
  formatDeniedTargetRouteFailure,
  isIdentityLoginInputPage,
  isRetryableBlankNavigationError,
  isLoginOrOauthCallbackPlumbingPath,
  isTargetApplicationPage,
  isTargetLoginOrOauthPlumbingPage,
  lxdOidcLoginUrlForSsoPage,
  shouldIgnoreHttpsErrors
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
    expect(bodyContainsAnyMarker("terrarium-primary\nUbuntu 24.04.3 LTS", ["Cockpit", "Ubuntu 24.04"])).toBe(true);
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
    expect(isTargetLoginOrOauthPlumbingPage("https://app.example.test/ui/login", "app.example.test")).toBe(true);
    expect(isTargetLoginOrOauthPlumbingPage("https://app.example.test/oidc/login", "app.example.test")).toBe(true);
    expect(isTargetLoginOrOauthPlumbingPage("https://app.example.test/protected", "app.example.test")).toBe(false);
    expect(isTargetLoginOrOauthPlumbingPage("https://auth.example.test/ui/v2/login/password", "app.example.test")).toBe(false);

    expect(isIdentityLoginInputPage("https://app.example.test/ui/login", "app.example.test")).toBe(false);
    expect(isIdentityLoginInputPage("https://app.example.test/oidc/login", "app.example.test")).toBe(false);
    expect(isIdentityLoginInputPage("https://auth.example.test/ui/v2/login/loginname?requestId=oidc_123", "app.example.test")).toBe(true);
    expect(isIdentityLoginInputPage("https://app.example.test/protected", "app.example.test")).toBe(true);
  });

  test("derives the direct LXD OIDC login endpoint from the SSO page", () => {
    expect(
      lxdOidcLoginUrlForSsoPage(
        "https://lxd.example.test/ui/login",
        "Canonical LXD\nLogin with SSO\nSet up TLS login",
        "lxd.example.test"
      )
    ).toBe("https://lxd.example.test/oidc/login");
    expect(lxdOidcLoginUrlForSsoPage("https://lxd.example.test/ui/login", "Canonical LXD", "lxd.example.test")).toBeUndefined();
    expect(
      lxdOidcLoginUrlForSsoPage(
        "https://auth.example.test/ui/v2/login/loginname",
        "Canonical LXD\nLogin with SSO",
        "lxd.example.test"
      )
    ).toBeUndefined();
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

  test("ignores HTTPS errors for host-pinned browser flows unless explicitly disabled", () => {
    expect(shouldIgnoreHttpsErrors({ resolveHosts: { "app.example.test": "203.0.113.10" } })).toBe(true);
    expect(shouldIgnoreHttpsErrors({ resolveHosts: { "app.example.test": "203.0.113.10" }, ignoreHTTPSErrors: false })).toBe(false);
    expect(shouldIgnoreHttpsErrors({ ignoreHTTPSErrors: true })).toBe(true);
    expect(shouldIgnoreHttpsErrors({})).toBe(false);
  });

  test("formats denied-route target failures with final URL and body snippet", () => {
    const message = formatDeniedTargetRouteFailure("https://app.example.test/protected", "terrarium-proxy-ok\nfixture reached");

    expect(message).toContain("browser reached the target host without denial text");
    expect(message).toContain("final url: https://app.example.test/protected");
    expect(message).toContain("terrarium-proxy-ok");
  });

  test("retries blank ZITADEL login documents without retrying visible form failures", () => {
    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "none of the selectors were visible: input[type=\"password\"]",
            "current URL: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123",
            "body:\n<empty>"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "none of the selectors were visible: input[type=\"password\"]",
            "current URL: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123",
            "body:\nLogin failed"
          ].join("\n")
        )
      )
    ).toBe(false);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "none of the identity selectors were visible: input[name=\"loginName\"]",
            "current URL: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123",
            "body:\n<empty>"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "browser login flow (entering username) timed out after 180000ms",
            "stage: entering username",
            "url: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            'failed to type stable value into [data-testid="username-text-input"]; final value length was 0',
            "current URL: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123",
            "body:\n<empty>"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "goto: Timeout 120000ms exceeded.",
            'Call log: - navigating to "https://group.example.test/", waiting until "commit"',
            "stage: opening target URL",
            "url: about:blank"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "forTimeout: Target page, context or browser has been closed",
            "stage: waiting for password input",
            "url: https://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123"
          ].join("\n")
        )
      )
    ).toBe(true);

    expect(
      isRetryableBlankNavigationError(
        new Error(
          [
            "forTimeout: Target page, context or browser has been closed",
            "stage: waiting for dashboard markers",
            "url: https://app.example.test/dashboard"
          ].join("\n")
        )
      )
    ).toBe(false);
  });
});
