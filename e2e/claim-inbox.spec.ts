import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");
  await page.getByRole("tab", { name: "Claim" }).click();
  await expect(page.getByRole("tabpanel", { name: "Claim" })).toBeVisible();
});

test("explains the chain-only mode when no Convex mirror is configured", async ({ page }) => {
  await expect(page.getByTestId("mirror-notice")).toBeVisible();
  await expect(page.getByTestId("mirror-notice")).toContainText("read directly from the vault on Base");
});

test("asks for a wallet before reading any recipient inbox", async ({ page }) => {
  await expect(page.getByText("The vault is not deployed yet.")).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeDisabled();
});

const describeControlSource = `(element) => {
  if (!(element instanceof HTMLElement) || element === document.body) return "";
  return element.id || element.getAttribute("aria-label") || (element.textContent ?? "").trim() || element.tagName;
}`;

test("reaches every enabled Claim control with the keyboard alone", async ({ page }) => {
  const panel = page.getByRole("tabpanel", { name: "Claim" });
  const expected = await panel.evaluate((element, source) => {
    const describeControl = new Function(`return (${source})`)() as (node: Element | null) => string;
    return Array.from(
      element.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      ),
    ).map(describeControl);
  }, describeControlSource);

  await page.getByRole("tab", { name: "Claim" }).focus();
  const reached: string[] = [];
  for (let step = 0; step < expected.length + 2; step += 1) {
    await page.keyboard.press("Tab");
    reached.push(
      await page.evaluate((source) => {
        const describeControl = new Function(`return (${source})`)() as (node: Element | null) => string;
        return describeControl(document.activeElement);
      }, describeControlSource),
    );
  }

  for (const control of expected) expect(reached).toContain(control);
  await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeDisabled();
  await expect(page.getByRole("tabpanel", { name: "Plant" })).toHaveCount(0);
});

test("keeps the claim panel inside the desktop frame without document scroll", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeInViewport();
  expect(
    await page.evaluate(() => ({
      viewportHeight: document.documentElement.clientHeight,
      pageHeight: document.documentElement.scrollHeight,
    })),
  ).toEqual({ viewportHeight: 720, pageHeight: 720 });
});
