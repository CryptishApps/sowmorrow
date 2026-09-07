import { defineConfig, devices } from "@playwright/test";
import preview from "./playwright.config";
export default defineConfig({
  ...preview,
  testDir: "./e2e/enabled",
  testIgnore: [],
  projects: [{ name: "enabled-chromium", use: devices["Desktop Chrome"] }],
});
