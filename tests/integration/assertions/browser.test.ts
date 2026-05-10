import { basename } from "node:path";
import { describe, expect, test } from "bun:test";
import { chromium, type Page } from "playwright";
import {
  __browserTestHooks,
  bodyContainsAnyMarker,
  bodyContainsDenialText,
  bodyContainsHttpErrorText,
  browserLifecycleTimeoutForLoginTargets,
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

  test("sizes composite browser lifecycles to cover nested login retry budgets", () => {
    expect(browserLifecycleTimeoutForLoginTargets(2)).toBeGreaterThan(15 * 60 * 1000);
    expect(browserLifecycleTimeoutForLoginTargets(3)).toBeGreaterThan(browserLifecycleTimeoutForLoginTargets(2));
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

  test("resubmits username only while still on the ZITADEL username route", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: [
            "<form>",
            '<input data-testid="username-text-input" value="">',
            '<button type="submit">Continue</button>',
            "</form>",
            "<script>",
            "window.submits = 0;",
            "document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.submits += 1; });",
            "</script>"
          ].join("")
        })
      );

      await page.goto("http://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123");
      await __browserTestHooks.resubmitUsernameIfStillOnUsernameStep(page, "agent@example.test");
      expect(await page.locator('[data-testid="username-text-input"]').inputValue()).toBe("agent@example.test");
      expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(1);

      await page.goto("http://issuer.example.test/ui/v2/login/password?requestId=oidc_123");
      await page.locator('[data-testid="username-text-input"]').fill("");
      await page.evaluate(() => {
        (window as unknown as { submits: number }).submits = 0;
      });
      await __browserTestHooks.resubmitUsernameIfStillOnUsernameStep(page, "agent@example.test");
      expect(await page.locator('[data-testid="username-text-input"]').inputValue()).toBe("");
      expect(await page.evaluate(() => (window as unknown as { submits: number }).submits)).toBe(0);
    } finally {
      await browser.close();
    }
  });

  test("waits through ZITADEL username to password transition without stale username typing", async () => {
    let currentUrl = "http://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123";
    let passwordVisible = false;
    let submits = 0;
    const evaluatedAt: string[] = [];
    const locatorFor = (selector: string) => ({
      first() {
        return this;
      },
      isVisible: async () => selector === '[data-testid="password-text-input"]' && passwordVisible,
      innerText: async () => ""
    });
    const page = {
      url: () => currentUrl,
      locator: locatorFor,
      waitForTimeout: async () => undefined,
      evaluate: async () => {
        evaluatedAt.push(currentUrl);
        if (currentUrl.includes("/ui/v2/login/loginname")) {
          submits += 1;
          currentUrl = "http://issuer.example.test/ui/v2/login/password?requestId=oidc_123";
          passwordVisible = true;
        }
      }
    } as unknown as Page;

    const result = await __browserTestHooks.waitForPasswordInputAfterUsernameSubmit(
      page,
      '[data-testid="username-text-input"]',
      "agent@example.test",
      "app.example.test"
    );

    expect(result).toEqual({ state: "password", selector: '[data-testid="password-text-input"]' });
    expect(currentUrl).toContain("/ui/v2/login/password");
    expect(passwordVisible).toBe(true);
    expect(submits).toBe(1);
    expect(evaluatedAt).toEqual(["http://issuer.example.test/ui/v2/login/loginname?requestId=oidc_123"]);
  });

  test("does not treat the target app password field as a ZITADEL password step", async () => {
    const page = {
      url: () => "https://app.example.test/",
      locator: (selector: string) => ({
        first() {
          return this;
        },
        isVisible: async () => selector === 'input[type="password"]',
        innerText: async () => "Ubuntu 24.04.3 LTS\nUser name\nPassword\nLog in"
      }),
      waitForTimeout: async () => undefined
    } as unknown as Page;

    const result = await __browserTestHooks.waitForPasswordInputAfterUsernameSubmit(
      page,
      '[data-testid="username-text-input"]',
      "agent@example.test",
      "app.example.test"
    );

    expect(result).toEqual({ state: "target" });
  });

  test("does not click a stale ZITADEL submit button after password Enter reaches the target", async () => {
    let currentUrl = "https://issuer.example.test/ui/v2/login/password?requestId=oidc_123";
    let clickedStaleSubmit = false;
    const passwordInput = {
      first() {
        return this;
      },
      focus: async () => undefined,
      press: async () => {
        currentUrl = "https://app.example.test/";
      },
      isVisible: async () => currentUrl.includes("/ui/v2/login/password"),
      isDisabled: async () => false
    };
    const submitButton = {
      first() {
        return this;
      },
      isVisible: async () => false,
      isDisabled: async () => false,
      click: async () => {
        clickedStaleSubmit = true;
      }
    };
    const page = {
      url: () => currentUrl,
      locator: (selector: string) => {
        if (selector === '[data-testid="password-text-input"]') {
          return passwordInput;
        }
        if (selector === '[data-testid="submit-button"]') {
          return submitButton;
        }
        return {
          first() {
            return this;
          },
          isVisible: async () => false,
          isDisabled: async () => false,
          click: async () => {
            clickedStaleSubmit = true;
          }
        };
      },
      waitForTimeout: async () => undefined
    } as unknown as Page;

    await __browserTestHooks.submitIdentityForm(page, '[data-testid="password-text-input"]', ['[data-testid="submit-button"]']);

    expect(currentUrl).toBe("https://app.example.test/");
    expect(clickedStaleSubmit).toBe(false);
  });
});
