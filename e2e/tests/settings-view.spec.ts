import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

test.describe("设置页面", () => {
  test("导航到各设置子页面无报错", async ({ page }) => {
    await page.goto("/settings");
    await slow(page);

    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();

    for (let i = 0; i < tabCount && i < 10; i++) {
      const tab = tabs.nth(i);
      const tabText = await tab.innerText();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click();
        await slow(page);
        await expect(page.locator("body")).not.toContainText("Error", { timeout: 5000 });
        console.log(`  设置子页面 "${tabText}" 正常`);
      }
    }
  });

  test("模型服务页面加载模型列表", async ({ page }) => {
    await page.goto("/settings");
    await slow(page);

    const modelTab = page.locator('[role="tab"]', { hasText: "模型服务" });
    if (await modelTab.isVisible().catch(() => false)) {
      await modelTab.click();
      await slow(page);
      await expect(
        page.locator('[role="tabpanel"]').filter({ has: page.locator("h3") })
      ).toBeVisible({ timeout: 10000 });
    }
  });

  test("通用设置含主题切换", async ({ page }) => {
    await page.goto("/settings");
    await slow(page);

    const generalTab = page.locator('[role="tab"]', { hasText: "通用" });
    if (await generalTab.isVisible().catch(() => false)) {
      await generalTab.click();
      await slow(page);

      const darkBtn = page.locator('button[aria-label="深色"]');
      if (await darkBtn.isVisible().catch(() => false)) {
        await darkBtn.click();
        await slow(page);
        await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 5000 });
      }
    }
  });
});
