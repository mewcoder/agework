import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3000;
const WEB_PORT = 5173;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "html",
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "cross-env AGEWORK_RUNTIME_ALLOWED_TYPES=native pnpm dev:server",
      cwd: "..",
      url: "http://localhost:3000/api/v1/auth/config",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm dev:web",
      cwd: "..",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
