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

test.describe("Library & Knowledge", () => {
  test.setTimeout(60_000);

  test("library page shows collections with source counts", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Library")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Hill90 Platform")).toBeVisible();
    // SharedKnowledgeClient.tsx renders `{n} source{n!==1?'s':''}` — the
    // count is genuinely singular when it's exactly 1. The plural-only
    // regex was the test being lazy about the component's own correct
    // grammar, not a stale selector; fixed to match either.
    await expect(page.getByText(/\d+ sources?/)).toBeVisible();
  });

  test("library search returns results", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    // Click Search tab
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByPlaceholder("Search shared knowledge...").fill("deployment");
    await page.getByRole("button", { name: "Search" }).nth(1).click();

    // Same singular/plural grammar as the source count above —
    // `{n} result{n!==1?'s':''}` in SharedKnowledgeClient.tsx.
    await expect(page.getByText(/\d+ results?/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Deployment Runbook")).toBeVisible();
  });

  test("library has Graph tab", async ({ page }) => {
    await login(page);
    await page.goto("/harness/shared-knowledge");
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Graph" }).click();
    await expect(page.getByText(/\d+ collections/)).toBeVisible({ timeout: 10_000 });
  });

  test("knowledge page shows agent entries", async ({ page }) => {
    await login(page);
    await page.goto("/harness/knowledge");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Agent Knowledge")).toBeVisible({ timeout: 10_000 });
    // Should show Browser Test v2 with entries
    await expect(page.getByText("Browser Test v2")).toBeVisible({ timeout: 10_000 });
  });
});
