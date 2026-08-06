import { test, expect, type Page } from "@playwright/test";

/**
 * Requires env vars, BOTH explicitly set — app#514: this file previously
 * had no doc comment at all, and its E2E_USERNAME defaulted independently
 * to jon@hill90.com, a real production account, while only E2E_PASSWORD
 * gated whether the suite ran. There is no default for either var now; a
 * missing one skips the suite rather than silently selecting an identity.
 *   E2E_USERNAME — this estate's documented test account: testuser01
 *   E2E_PASSWORD — its password
 */

const E2E_USERNAME = process.env.E2E_USERNAME ?? "";
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "";

test.skip(
  !E2E_USERNAME || !E2E_PASSWORD,
  "E2E_USERNAME and E2E_PASSWORD must both be set explicitly"
);

async function login(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const signIn = page.getByTestId("landing-sign-in");
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click();
    await page.waitForURL(/auth\.hill90\.com/, { timeout: 15_000 });
  }
  if (page.url().includes("auth.hill90.com")) {
    await page.getByLabel(/username or email/i).fill(E2E_USERNAME);
    await page.getByRole("textbox", { name: /password/i }).fill(E2E_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/hill90\.com/, { timeout: 15_000 });
    await page.waitForLoadState("networkidle");
  }
}

test.describe("TopBar Features", () => {
  test.setTimeout(60_000);

  test("global search bar is visible on desktop", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await expect(search).toBeVisible({ timeout: 10_000 });
    await expect(search).toHaveAttribute("placeholder", /search knowledge/i);
  });

  test("search bar navigates to library on enter", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await search.fill("test query");
    await search.press("Enter");

    // TopBar.tsx navigates via
    // `?q=${encodeURIComponent(searchQuery.trim())}`, which percent-encodes
    // a space as %20 — never as a literal `+`. This asserted on the raw URL
    // containing `test+query`, which encodeURIComponent was never going to
    // produce; investigated whether the app or the test was wrong before
    // touching either (per review): the consumer,
    // shared-knowledge/page.tsx's `searchParams.get('q')`, is Next.js's
    // useSearchParams(), backed by the standard URLSearchParams — verified
    // empirically that URLSearchParams treats `+` and `%20` as identical,
    // both decoding to a literal space (`new URLSearchParams("q=test+query")
    // .get("q")` and `new URLSearchParams("q=test%20query").get("q")` both
    // return "test query"). So the app's encoding is correct and the
    // consumer reads it correctly either way — this was the test asserting
    // a raw-URL encoding detail unrelated to whether search actually works,
    // not an app bug. Fixed to check the DECODED query value via the URL
    // object, which is correct regardless of which valid encoding the app
    // chooses to produce.
    await page.waitForURL(
      (url) => url.pathname.includes("shared-knowledge") && url.searchParams.get("q") === "test query",
      { timeout: 10_000 }
    );
  });

  test("search bar is hidden on mobile", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("global-search");
    await expect(search).not.toBeVisible();
  });

  test("notifications bell is visible", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bell = page.getByTestId("notifications-bell");
    await expect(bell).toBeVisible({ timeout: 10_000 });
  });

  test("notifications dropdown opens on click", async ({ page }) => {
    await login(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("notifications-bell").click();
    const dropdown = page.getByTestId("notifications-dropdown");
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Notifications")).toBeVisible();
  });
});
