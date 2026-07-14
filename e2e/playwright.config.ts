import { defineConfig, devices } from "@playwright/test";

// 与 dev 约定一致:server 读 PORT(默认 3000),vite 固定 5173
const API_PORT = Number(process.env.PORT ?? 3000);
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
      url: `http://localhost:${API_PORT}/api/v1/auth/config`,
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
