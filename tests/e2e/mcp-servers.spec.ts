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

test.describe("MCP Servers Page", () => {
  test.setTimeout(60_000);

  test("renders MCP servers page", async ({ page }) => {
    await login(page);
    await page.goto("/harness/mcp-servers");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("MCP Servers")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Add Server")).toBeVisible();
  });

  test("can open create form with transport options", async ({ page }) => {
    await login(page);
    await page.goto("/harness/mcp-servers");
    await page.waitForLoadState("networkidle");

    await page.getByText("Add Server").click();
    await expect(page.getByText("Transport")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("stdio (local process)")).toBeVisible();
  });
});
