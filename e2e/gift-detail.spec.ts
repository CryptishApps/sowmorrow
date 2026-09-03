import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const vault = "0x4444444444444444444444444444444444444444";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("reads a gift link without a wallet while the manifest is still pending", async ({ page }) => {
  const response = await page.goto(`/gift/8453/${vault}/1`);
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "This vault is not planted yet." })).toBeVisible();
  await expect(page.getByTestId("gift-pending-manifest")).toContainText("no active reviewed Sowmorrow");
  await expect(page.getByText(vault)).toBeVisible();
  await expect(page.getByText("Gift #1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Sowmorrow" })).toHaveAttribute("href", "/");
});

test("returns to the home page from a pending gift link", async ({ page }) => {
  await page.goto(`/gift/8453/${vault}/1`);
  await page.getByRole("link", { name: "Back to Sowmorrow" }).click();
  await expect(page.getByRole("tabpanel", { name: "Plant" })).toBeVisible();
});

test.describe("invalid gift links", () => {
  for (const [name, path] of [
    ["an unknown chain", `/gift/1/${vault}/1`],
    ["a malformed vault", "/gift/8453/0xnope/1"],
    ["gift zero", `/gift/8453/${vault}/0`],
    ["a non-canonical gift id", `/gift/8453/${vault}/007`],
  ] as const) {
    test(`answers 404 for ${name}`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "No gift lives at that link." })).toBeVisible();
    });
  }
});

test("has no automatically detectable accessibility violations on a gift link", async ({ page }) => {
  await page.goto(`/gift/8453/${vault}/1`);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
