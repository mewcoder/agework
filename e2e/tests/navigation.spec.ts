import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

test.describe("页面导航", () => {
  test("首页加载正常", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("button", { hasText: "新会话" })).toBeVisible({
      timeout: 15000,
    });
    await slow(page);
    await expect(
      page.locator('button[aria-label="新建工作空间"]')
    ).toBeVisible();
    await slow(page);
  });

  test("设置页面可访问", async ({ page }) => {
    await page.goto("/settings");
    await slow(page);
    await expect(page.locator("body")).not.toContainText("Error", {
      timeout: 5000,
    });
  });
});
