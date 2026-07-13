import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

test.describe("页面导航", () => {
  test("首页加载正常", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "新会话" })).toBeVisible({
      timeout: 15000,
    });
    await slow(page);
    // 首页主体是落地 composer;侧栏"新建工作空间"图标现在悬停才挂载,不再作为首页断言
    await expect(
      page.locator('textarea[aria-label="消息输入"]')
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
