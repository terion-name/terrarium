import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { OidcTestUser } from "../types";

type LoginExpectation = "allow" | "deny";
type BrowserArtifactKind = "success" | "failure";

type LoginOptions = {
  outputDir: string;
  resolveHosts?: Record<string, string>;
  expected?: LoginExpectation;
  ignoreHTTPSErrors?: boolean;
};

const BROWSER_WAIT_TIMEOUT_MS = 120000;
const BROWSER_CLOSE_TIMEOUT_MS = 10000;
const BODY_SNIPPET_LENGTH = 4000;
const DENIAL_TEXT_MARKERS = ["403", "forbidden", "access denied", "not authorized", "permission denied"] as const;
const ERROR_TEXT_MARKERS = [
  "400 bad request",
  "401 unauthorized",
  "403 forbidden",
  "404 page not found",
  "500 internal server error",
  "502 bad gateway",
  "503 service unavailable",
  "504 gateway timeout",
  "bad gateway",
  "service unavailable",
  "gateway timeout"
] as const;
const COCKPIT_TEXT_MARKERS = ["Cockpit", "Log in", "Username", "Password"] as const;
const TRAEFIK_TEXT_MARKERS = ["Traefik", "Dashboard", "HTTP", "Routers", "Services"] as const;
const USERNAME_SUBMIT_SELECTORS = submitControlSelectors(["Next", "Continue", "Sign in"]);
const PASSWORD_SUBMIT_SELECTORS = submitControlSelectors(["Sign in", "Login", "Continue"]);

async function firstVisible(page: Page, selectors: string[]): Promise<string> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return selector;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`none of the selectors were visible: ${selectors.join(", ")}`);
}

async function clickFirst(page: Page, selectors: string[]): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.isVisible().catch(() => false)) && !(await locator.isDisabled().catch(() => false))) {
        await locator.click();
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`none of the click selectors became enabled: ${selectors.join(", ")}`);
}

async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible" });
  await locator.click({ force: true });
  await locator.fill("");
  await locator.type(value, { delay: 5 });

  let actual = await locator.inputValue().catch(() => "");
  if (actual !== value) {
    await locator.fill(value);
    actual = await locator.inputValue().catch(() => "");
  }

  if (actual !== value) {
    await locator.evaluate(
      (element, inputValue) => {
        const input = element as HTMLInputElement;
        input.value = inputValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      value
    );
    actual = await locator.inputValue().catch(() => "");
  }

  if (actual !== value) {
    throw new Error(`failed to type into ${selector}; final value length was ${actual.length}`);
  }

  await locator.dispatchEvent("input");
  await locator.dispatchEvent("change");
  await locator.press("Tab").catch(() => undefined);
}

function submitControlSelectors(labels: string[]): string[] {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const labelPattern = escapedLabels.join("|");
  return [
    '[data-testid="submit-button"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'input[type="button"]',
    ...labels.flatMap((label) => [
      `button:has-text("${label}")`,
      `[role="button"]:has-text("${label}")`,
      `input[type="submit"][value="${label}"]`,
      `input[type="button"][value="${label}"]`
    ]),
    `text=/^\\s*(${labelPattern})\\s*$/i`
  ];
}

async function waitForEnabled(page: Page, selectors: string[]): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.isVisible().catch(() => false)) && !(await locator.isDisabled().catch(() => false))) {
        return;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`none of the selectors became enabled: ${selectors.join(", ")}`);
}

async function submitForm(page: Page, buttonSelectors: string[]): Promise<void> {
  await clickFirst(page, buttonSelectors);
}

async function waitForReturnToTargetHost(
  page: Page,
  targetHost: string,
  userEmail: string,
  expected: LoginExpectation
): Promise<void> {
  const deadline = Date.now() + BROWSER_WAIT_TIMEOUT_MS;
  let lastResubmit = 0;
  let lastAccountSelectionClick = 0;

  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const body = await page.locator("body").innerText().catch(() => "");
    const normalizedBody = body.toLowerCase();

    if (expected === "deny" && bodyContainsDenialText(body)) {
      return;
    }

    if (isTargetApplicationPage(currentUrl, targetHost)) {
      if (expected === "allow") {
        return;
      }
      throw new Error(formatDeniedTargetRouteFailure(currentUrl, body));
    }

    const onAccountSelectionStep =
      currentUrl.includes("/ui/v2/login/accounts") ||
      (normalizedBody.includes("select the account") && normalizedBody.includes(userEmail.toLowerCase()));

    if (onAccountSelectionStep) {
      const now = Date.now();
      if (now - lastAccountSelectionClick > 5000 && (await clickAccountSelection(page, userEmail))) {
        lastAccountSelectionClick = now;
        await page.waitForTimeout(1500);
        continue;
      }
    }

    if (
      normalizedBody.includes("password is wrong") ||
      normalizedBody.includes("user not found") ||
      normalizedBody.includes("invalid password") ||
      normalizedBody.includes("invalid login") ||
      normalizedBody.includes("login failed")
    ) {
      throw new Error(`ZITADEL login failed before returning to ${targetHost}\nbody:\n${bodySnippetForError(body)}`);
    }

    const remainingMs = deadline - Date.now();
    const onPasswordStep =
      currentUrl.includes("/ui/v2/login/password") ||
      (normalizedBody.includes("password") && normalizedBody.includes("reset password"));

    if (onPasswordStep && Date.now() - lastResubmit > 5000 && remainingMs < BROWSER_WAIT_TIMEOUT_MS - 5000) {
      const passwordInput = page.locator('[data-testid="password-text-input"], input[name="password"], input[type="password"]').first();
      if (await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.press("Enter").catch(() => undefined);
        await clickFirst(page, PASSWORD_SUBMIT_SELECTORS).catch(() => undefined);
        lastResubmit = Date.now();
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`timed out waiting to return to target host ${targetHost} from ZITADEL`);
}

async function clickAccountSelection(page: Page, userEmail: string): Promise<boolean> {
  const encodedEmail = encodeURIComponent(userEmail);
  const hrefSelectors = [`a[href*="loginName=${encodedEmail}"]`, `a[href*="${encodedEmail}"]`];

  for (const selector of hrefSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click().catch(() => undefined);
      return true;
    }
  }

  for (const role of ["link", "button"] as const) {
    const locator = page.getByRole(role, { name: new RegExp(userEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ force: true }).catch(() => undefined);
      return true;
    }
  }

  const accountCardClick = await accountSelectionClickPoint(page, userEmail);
  if (accountCardClick) {
    await page.mouse.click(accountCardClick.x, accountCardClick.y);
    await page.waitForTimeout(500);
    if (!page.url().includes("/ui/v2/login/accounts")) {
      return true;
    }
  }

  const textTargets = [userEmail, userEmail.split("@")[0] ?? userEmail];
  for (const text of textTargets) {
    const candidates = page.getByText(text, { exact: false });
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const textLocator = candidates.nth(index);
      if (!(await textLocator.isVisible().catch(() => false))) {
        continue;
      }

      const clickableAncestor = textLocator.locator("xpath=ancestor-or-self::*[self::a or self::button or @role='button' or @tabindex][1]").first();
      if (await clickableAncestor.isVisible().catch(() => false)) {
        await clickableAncestor.click({ force: true }).catch(() => undefined);
        return true;
      }

      await textLocator.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(500);
      if (!page.url().includes("/ui/v2/login/accounts")) {
        return true;
      }

      const clickableCard = textLocator.locator("xpath=ancestor::div[1]").first();
      const cardBox = await clickableCard.boundingBox().catch(() => null);
      if (cardBox) {
        await page.mouse.click(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
        await page.waitForTimeout(500);
        if (!page.url().includes("/ui/v2/login/accounts")) {
          return true;
        }
      }

      const textBox = await textLocator.boundingBox().catch(() => null);
      if (textBox) {
        await page.mouse.click(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2);
        await page.waitForTimeout(500);
        if (!page.url().includes("/ui/v2/login/accounts")) {
          return true;
        }
      }
    }
  }

  return false;
}

async function accountSelectionClickPoint(page: Page, userEmail: string): Promise<{ x: number; y: number } | undefined> {
  return await page
    .evaluate((email) => {
      const normalizedEmail = email.toLowerCase();
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
      };
      const candidateElements: Element[] = [];
      for (const element of document.querySelectorAll("a,button,[role='button'],[tabindex],div,li")) {
        const text = (element.textContent ?? "").toLowerCase();
        if (text.includes(normalizedEmail) && isVisible(element)) {
          candidateElements.push(element);
        }
      }

      const scored = candidateElements
        .map((element) => {
          const box = element.getBoundingClientRect();
          if (box.width < 120 || box.height < 32 || box.width > window.innerWidth * 0.9 || box.height > 240) {
            return undefined;
          }

          const style = window.getComputedStyle(element);
          let score = 0;
          if (element instanceof HTMLAnchorElement || element instanceof HTMLButtonElement) {
            score += 1000;
          }
          if (element.getAttribute("role") === "button") {
            score += 700;
          }
          if (element.hasAttribute("tabindex")) {
            score += 400;
          }
          if (style.cursor === "pointer") {
            score += 350;
          }
          if (box.width >= 250 && box.height >= 60) {
            score += 250;
          }
          score -= Math.abs(box.width - 360) / 10;
          score -= Math.abs(box.height - 96) / 5;
          return {
            score,
            x: box.left + box.width * 0.45,
            y: box.top + box.height / 2
          };
        })
        .filter((candidate): candidate is { score: number; x: number; y: number } => Boolean(candidate))
        .sort((left, right) => right.score - left.score);

      const target = scored[0];
      if (!target) {
        return undefined;
      }
      return { x: target.x, y: target.y };
    }, userEmail)
    .catch(() => undefined);
}

/** Runs a browser flow and preserves screenshots for post-failure inspection. */
export async function withBrowser<T>(
  outputDir: string,
  runFlow: (browser: Browser) => Promise<T>,
  options: { resolveHosts?: Record<string, string>; ignoreHTTPSErrors?: boolean } = {}
): Promise<T> {
  mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: hostResolverRules(options.resolveHosts).map((rules) => `--host-resolver-rules=${rules}`)
  });
  try {
    return await runFlow(browser);
  } finally {
    await withCloseTimeout(browser.close());
  }
}

async function withCloseTimeout(close: Promise<unknown>): Promise<void> {
  await Promise.race([
    close.then(() => undefined).catch(() => undefined),
    Bun.sleep(BROWSER_CLOSE_TIMEOUT_MS)
  ]);
}

async function loginThroughZitadelWithBrowser(
  browser: Browser,
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  const expected = options.expected ?? "allow";
  const screenshotPath = browserScreenshotPath(options.outputDir, url, user.email, expected, "success");
  const targetHost = new URL(url).host;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let stage = "creating browser context";

  try {
    context = await browser.newContext({ ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false });
    stage = "opening browser page";
    page = await context.newPage();
    page.setDefaultTimeout(BROWSER_WAIT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BROWSER_WAIT_TIMEOUT_MS);

    stage = "opening target URL";
    await page.goto(url, { waitUntil: "commit", timeout: BROWSER_WAIT_TIMEOUT_MS });

    stage = "waiting for username input";
    const emailSelector = await firstVisible(page, [
      '[data-testid="username-text-input"]',
      'input[name="loginName"]',
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name="username"]'
    ]);
    stage = "entering username";
    await typeInto(page, emailSelector, user.email);
    stage = "waiting for username submit";
    await waitForEnabled(page, USERNAME_SUBMIT_SELECTORS);
    stage = "submitting username";
    await submitForm(page, USERNAME_SUBMIT_SELECTORS);

    stage = "waiting for password input";
    const passwordSelector = await firstVisible(page, [
      '[data-testid="password-text-input"]',
      'input[name="password"]',
      'input[autocomplete="password"]',
      'input[autocomplete="current-password"]',
      'input[type="password"]'
    ]);
    stage = "entering password";
    await typeInto(page, passwordSelector, user.password);
    stage = "waiting for password submit";
    await waitForEnabled(page, PASSWORD_SUBMIT_SELECTORS);
    stage = "submitting password";
    await submitForm(page, PASSWORD_SUBMIT_SELECTORS);

    stage = `waiting for ${expected} return to target host`;
    await waitForReturnToTargetHost(page, targetHost, user.email, expected);
    stage = "waiting for post-login document";
    await page.waitForLoadState("domcontentloaded", { timeout: BROWSER_WAIT_TIMEOUT_MS }).catch(() => undefined);
    stage = "capturing success screenshot";
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const finalUrl = page.url();
    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    return { finalUrl, screenshotPath, bodyText, title };
  } catch (error) {
    const failurePath = browserScreenshotPath(options.outputDir, url, user.email, expected, "failure");
    let failureScreenshot: string | undefined;
    if (page) {
      failureScreenshot = await page.screenshot({ path: failurePath, fullPage: true }).then(() => failurePath).catch(() => undefined);
    }
    const bodySnippet = page ? await page.locator("body").innerText().then(bodySnippetForError).catch(() => "") : "";
    const finalUrl = page?.url() ?? "<page unavailable>";
    const detail = [`stage: ${stage}`, `url: ${finalUrl}`];
    if (failureScreenshot) {
      detail.push(`screenshot: ${failureScreenshot}`);
    }
    if (bodySnippet) {
      detail.push(`body:\n${bodySnippet}`);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${detail.join("\n\n")}`);
  } finally {
    if (context) {
      await withCloseTimeout(context.close());
    }
  }
}

/** Completes the ZITADEL login flow and returns on the post-login target page. */
export async function loginThroughZitadel(
  url: string,
  user: OidcTestUser,
  options: LoginOptions
): Promise<{ finalUrl: string; screenshotPath: string; bodyText: string; title: string }> {
  return await withBrowser(
    options.outputDir,
    async (browser) => await loginThroughZitadelWithBrowser(browser, url, user, options),
    { resolveHosts: options.resolveHosts, ignoreHTTPSErrors: options.ignoreHTTPSErrors }
  );
}

/** Verifies that OIDC gating returns the user to Cockpit’s own PAM login form. */
export async function expectCockpitLogin(url: string, user: OidcTestUser, outputDir: string): Promise<string> {
  const result = await loginThroughZitadel(url, user, { outputDir });
  const final = new URL(result.finalUrl);
  const target = new URL(url);
  if (final.host !== target.host) {
    throw new Error(`unexpected post-login cockpit host: ${result.finalUrl}`);
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

/** Verifies the Cockpit and Traefik management surfaces in one browser lifecycle. */
export async function expectManagementUi(
  manageUrl: string,
  proxyUrl: string,
  user: OidcTestUser,
  outputDir: string,
  options: { resolveIp?: string; resolveHosts?: Record<string, string> } = {}
): Promise<void> {
  const resolveHosts = {
    ...(options.resolveHosts ?? {}),
    ...(options.resolveIp
      ? {
          [new URL(manageUrl).hostname]: options.resolveIp,
          [new URL(proxyUrl).hostname]: options.resolveIp
        }
      : {})
  };
  await withBrowser(outputDir, async (browser) => {
    const cockpit = await loginThroughZitadelWithBrowser(browser, manageUrl, user, { outputDir });
    const cockpitFinal = new URL(cockpit.finalUrl);
    const cockpitTarget = new URL(manageUrl);
    if (cockpitFinal.host !== cockpitTarget.host) {
      throw new Error(`unexpected post-login cockpit host: ${cockpit.finalUrl}`);
    }
    assertUserFacingPageBody(`${cockpit.title}\n${cockpit.bodyText}`, COCKPIT_TEXT_MARKERS, "Cockpit");

    const proxy = await loginThroughZitadelWithBrowser(browser, proxyUrl, user, { outputDir });
    if (!proxy.finalUrl.includes("/dashboard")) {
      throw new Error(`unexpected Traefik dashboard URL: ${proxy.finalUrl}`);
    }
    assertUserFacingPageBody(`${proxy.title}\n${proxy.bodyText}`, TRAEFIK_TEXT_MARKERS, "Traefik dashboard");
  }, { resolveHosts: Object.keys(resolveHosts).length > 0 ? resolveHosts : undefined });
}

/** Verifies a protected published route for either allow or deny behavior. */
export async function expectProtectedRoute(
  url: string,
  user: OidcTestUser,
  expected: LoginExpectation,
  outputDir: string,
  bodyNeedle = "",
  options: { resolveIp?: string } = {}
): Promise<string> {
  const resolveHosts = options.resolveIp ? { [new URL(url).hostname]: options.resolveIp } : undefined;
  const result = await loginThroughZitadel(url, user, { outputDir, resolveHosts, expected });
  if (expected === "allow") {
    if (bodyNeedle && !result.bodyText.includes(bodyNeedle)) {
      throw new Error(`expected protected route body to include "${bodyNeedle}"`);
    }
    return result.screenshotPath;
  }

  if (!bodyContainsDenialText(result.bodyText)) {
    throw new Error("expected denied protected route to show a forbidden/denied page");
  }
  return result.screenshotPath;
}

function slugForPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "page";
}

export function browserScreenshotPath(
  outputDir: string,
  url: string,
  userEmail: string,
  expected: LoginExpectation,
  kind: BrowserArtifactKind
): string {
  return join(outputDir, `${slugForPath(url)}-${expected}-${slugForPath(userEmail)}-${kind}.png`);
}

export function bodyContainsDenialText(body: string): boolean {
  const normalized = body.toLowerCase();
  return DENIAL_TEXT_MARKERS.some((marker) => normalized.includes(marker));
}

export function bodyContainsHttpErrorText(body: string): boolean {
  const normalized = body.toLowerCase();
  return ERROR_TEXT_MARKERS.some((marker) => normalized.includes(marker));
}

export function bodyContainsAnyMarker(body: string, markers: readonly string[]): boolean {
  const normalized = body.toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function assertUserFacingPageBody(body: string, markers: readonly string[], label: string): void {
  if (bodyContainsHttpErrorText(body)) {
    throw new Error(`${label} rendered an HTTP error page:\n${bodySnippetForError(body)}`);
  }
  if (!bodyContainsAnyMarker(body, markers)) {
    throw new Error(`${label} did not render expected UI markers; body:\n${bodySnippetForError(body) || "<empty>"}`);
  }
}

export function isLoginOrOauthCallbackPlumbingPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return normalized.startsWith("/ui/v2/login") || normalized.startsWith("/ui/login") || normalized === "/oauth2" || normalized.startsWith("/oauth2/");
}

export function isTargetApplicationPage(currentUrl: string, targetHost: string): boolean {
  const parsed = parseBrowserUrl(currentUrl);
  return Boolean(parsed && parsed.host === targetHost && !isLoginOrOauthCallbackPlumbingPath(parsed.pathname));
}

export function formatDeniedTargetRouteFailure(finalUrl: string, body: string): string {
  return [
    "expected denied protected route to show a denial page, but the browser reached the target host without denial text",
    `final url: ${finalUrl}`,
    `body:\n${bodySnippetForError(body) || "<empty>"}`
  ].join("\n");
}

function bodySnippetForError(body: string): string {
  return body.slice(0, BODY_SNIPPET_LENGTH);
}

function parseBrowserUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hostResolverRules(resolveHosts?: Record<string, string>): string[] {
  const entries = Object.entries(resolveHosts ?? {});
  if (entries.length === 0) {
    return [];
  }
  const mappings = entries.map(([host, ip]) => `MAP ${host} ${ip}`);
  mappings.push("EXCLUDE localhost");
  return [mappings.join(",")];
}
