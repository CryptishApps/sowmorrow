import { expect, test } from "@playwright/test";

test("allows the app to hydrate while blocking scripts without a fresh nonce", async ({ page }) => {
  await page.route("http://127.0.0.1:3217/", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "</head>",
      "<script>document.documentElement.dataset.injected = 'yes'</script></head>",
    );
    await route.fulfill({ response, body });
  });
  const response = await page.goto("/");
  const policy = response!.headers()["content-security-policy"];
  expect(policy).toContain("'strict-dynamic'");
  expect(policy).not.toContain("'unsafe-eval'");
  const nonce = await page
    .locator("script[nonce]")
    .first()
    .evaluate((script) => (script as HTMLScriptElement).nonce);
  expect(nonce).toBeTruthy();
  expect(policy).toContain(`'nonce-${nonce}'`);
  await expect(page.locator("html")).not.toHaveAttribute("data-injected", "yes");
  await page.getByRole("tab", { name: "Claim", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Claim" })).toBeVisible();
  const second = await page.reload();
  expect(second!.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
});
