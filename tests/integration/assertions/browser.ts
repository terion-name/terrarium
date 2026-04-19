import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { OidcTestUser } from "../types";

type LoginOptions = {
  outputDir: string;
};

async function firstVisible(page: Page, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return selector;
    }
  }
  throw new Error(`none of the selectors were visible: ${selectors.join(", ")}`);
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return;
    }
  }
  throw new Error(`none of the click selectors were visible: ${selectors.join(", ")}`);
}

/** Runs a browser flow and preserves screenshots for post-failure inspection. */
export async function withBrowser<T>(outputDir: string, runFlow: (browser: Browser) => Promise<T>): Promise<T> {
  mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    return await runFlow(browser);
  } finally {
    await browser.close();
  }
}

/** Completes the ZITADEL login flow and returns on the post-login target page. */
export async function loginThroughZitadel(url: string, user: OidcTestUser, options: LoginOptions): Promise<{ finalUrl: string; screenshotPath: string }> {
  return await withBrowser(options.outputDir, async (browser) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const emailSelector = await firstVisible(page, [
      'input[type="email"]',
      'input[name="loginName"]',
      'input[name="username"]',
      'input[autocomplete="username"]'
    ]);
    await page.fill(emailSelector, user.email);
    await clickFirst(page, ['button:has-text("Next")', 'button:has-text("Continue")', 'button:has-text("Sign in")']);

    const passwordSelector = await firstVisible(page, [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]'
    ]);
    await page.fill(passwordSelector, user.password);
    await clickFirst(page, ['button:has-text("Sign in")', 'button:has-text("Login")', 'button:has-text("Continue")']);

    await page.waitForLoadState("networkidle", { timeout: 120000 });
    const screenshotPath = join(options.outputDir, `${slugForPath(url)}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const finalUrl = page.url();
    await context.close();
    return { finalUrl, screenshotPath };
  });
}

/** Verifies that OIDC gating returns the user to Cockpit’s own PAM login form. */
export async function expectCockpitLogin(url: string, user: OidcTestUser, outputDir: string): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  if (!result.finalUrl.includes("/")) {
    throw new Error(`unexpected post-login cockpit URL: ${result.finalUrl}`);
  }
  return result.screenshotPath;
}

/** Verifies that the Traefik dashboard becomes reachable after OIDC login. */
export async function expectTraefikDashboard(url: string, user: OidcTestUser, outputDir: string): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  if (!result.finalUrl.includes("/dashboard")) {
    throw new Error(`unexpected Traefik dashboard URL: ${result.finalUrl}`);
  }
  return result.screenshotPath;
}

/** Verifies a protected published route for either allow or deny behavior. */
export async function expectProtectedRoute(
  url: string,
  user: OidcTestUser,
  expected: "allow" | "deny",
  outputDir: string,
  bodyNeedle = ""
): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  if (expected === "allow") {
    if (bodyNeedle) {
      const response = await fetch(result.finalUrl, { redirect: "follow" });
      const body = await response.text();
      if (!body.includes(bodyNeedle)) {
        throw new Error(`expected protected route body to include "${bodyNeedle}"`);
      }
    }
    return result.screenshotPath;
  }

  const response = await fetch(result.finalUrl, { redirect: "manual" });
  if (![401, 403].includes(response.status)) {
    throw new Error(`expected denied protected route to return 401/403, got ${response.status}`);
  }
  return result.screenshotPath;
}

function slugForPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}
