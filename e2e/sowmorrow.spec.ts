import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("publishes social sharing metadata and app icons", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute("content", "Sowmorrow");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /\/opengraph-image\.png/,
  );
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    "content",
    /Plant a stock for someone’s tomorrow/,
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", /\/twitter-image\.png/);
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute(
    "content",
    /Plant a stock for someone’s tomorrow/,
  );
  await expect(page.locator('link[rel="icon"][sizes="16x16"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][sizes="32x32"][href*="favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][sizes="32x32"][href*="icon2.png"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][sizes="192x192"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][sizes="512x512"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"][sizes="180x180"]')).toHaveCount(1);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /\/manifest\.webmanifest/);

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  await expect(manifestResponse.json()).resolves.toMatchObject({
    icons: [
      { src: "/icon3.png", sizes: "192x192", type: "image/png" },
      { src: "/icon4.png", sizes: "512x512", type: "image/png" },
    ],
  });

  const giftPath = "/gift/8453/0x2222222222222222222222222222222222222222/7";
  await page.goto(giftPath);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${giftPath}$`));
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    "content",
    new RegExp(`${giftPath}$`),
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "A planted gift — Sowmorrow",
  );
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute(
    "content",
    "A planted gift — Sowmorrow",
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /\/opengraph-image\.png/,
  );
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", /\/twitter-image\.png/);
});

test("shows all 13 reviewed stocks in one discoverable rail", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Plant a stock for someone’s tomorrow." })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(13);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(page.getByTestId("stock-fade-left")).toHaveCount(0);
  await expect(page.getByTestId("stock-fade-right")).toBeVisible();

  await page.getByTestId("stock-rail").evaluate((rail) => {
    rail.scrollLeft = rail.scrollWidth;
    rail.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByTestId("stock-fade-left")).toBeVisible();
  await expect(page.getByTestId("stock-fade-right")).toHaveCount(0);
});

test("selects a stock with a mouse click and updates the amount symbol", async ({ page }) => {
  await page.goto("/");
  const amazon = page.getByRole("radio", { name: "Amazon · AMZNc" });
  await amazon.click();
  await expect(amazon).toBeChecked();
  await expect(page.getByRole("radio", { name: "Apple · AAPLc" })).not.toBeChecked();
  await expect(page.getByRole("textbox", { name: /How much/ }).locator("..")).toContainText("AMZNc");
});

test("drags the stock rail without changing the selected stock", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  const rail = page.getByTestId("stock-rail");
  await expect(rail).toBeVisible();
  const bounds = await rail.boundingBox();
  expect(bounds).not.toBeNull();
  await expect(page.getByRole("radio", { name: "Apple · AAPLc" })).toBeChecked();

  await page.mouse.move(bounds!.x + bounds!.width * 0.8, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.2, bounds!.y + bounds!.height / 2, { steps: 8 });
  await page.mouse.up();

  expect(await rail.evaluate((element) => element.scrollLeft)).toBeGreaterThan(100);
  await expect(page.getByRole("radio", { name: "Apple · AAPLc" })).toBeChecked();
});

test("fits the complete Plant mini app in a 1280 by 720 desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  await expect(page.getByRole("tabpanel", { name: "Plant" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeInViewport();
  expect(
    await page.evaluate(() => ({
      viewportHeight: document.documentElement.clientHeight,
      pageHeight: document.documentElement.scrollHeight,
    })),
  ).toEqual({ viewportHeight: 720, pageHeight: 720 });
});

test("keeps the interface painted when reduced motion is requested", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Plant a stock for someone’s tomorrow." })).toHaveCSS(
    "opacity",
    "1",
  );
});

test("contains growing state inside the desktop app frame", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/");

  for (const face of ["plant", "claim"] as const) {
    if (face === "claim") await page.getByRole("tab", { name: "Claim" }).click();
    const region = page.getByTestId(`${face}-scroll-region`);
    await expect(region).toBeVisible();
    await region.evaluate((element) => {
      const probe = document.createElement("div");
      probe.setAttribute("aria-hidden", "true");
      probe.style.blockSize = "800px";
      probe.style.flex = "0 0 800px";
      element.append(probe);
    });

    expect(await region.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeInViewport();
    expect(
      await page.evaluate(() => ({
        viewportHeight: document.documentElement.clientHeight,
        pageHeight: document.documentElement.scrollHeight,
      })),
    ).toEqual({ viewportHeight: 720, pageHeight: 720 });
  }
});

test("switches faces without document scroll or hidden controls", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.getByRole("tabpanel", { name: "Plant" })).toBeVisible();
  await page.waitForTimeout(1_100);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.trackScrollHeight = "true";
    root.dataset.maxScrollHeight = String(root.scrollHeight);
    const measure = () => {
      root.dataset.maxScrollHeight = String(
        Math.max(Number(root.dataset.maxScrollHeight ?? 0), root.scrollHeight),
      );
      if (root.dataset.trackScrollHeight === "true") requestAnimationFrame(measure);
    };
    requestAnimationFrame(measure);
  });
  const plantTab = page.getByRole("tab", { name: "Plant" });
  await plantTab.focus();
  await plantTab.press("ArrowRight");
  await expect(page.getByRole("tabpanel", { name: "Claim" })).toBeVisible();
  await expect(page.getByRole("tabpanel", { name: "Plant" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Claim" })).toBeFocused();
  await expect(page.getByText("Your planted gifts")).toBeVisible();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.trackScrollHeight = "false";
      return {
        current: root.scrollHeight,
        maximum: Number(root.dataset.maxScrollHeight),
        viewport: root.clientHeight,
      };
    }),
  ).toEqual({ current: 720, maximum: 720, viewport: 720 });
  await expect(page.getByRole("button", { name: "Vault deployment pending" })).toBeInViewport();
});

test("has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("keeps the card in the viewport while preserving rail overflow cues", async ({ page }) => {
    await page.goto("/");
    const card = page.getByRole("tabpanel", { name: "Plant" });
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await expect(page.getByTestId("stock-fade-right")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
