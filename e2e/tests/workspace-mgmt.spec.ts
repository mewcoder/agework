import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

async function createWorkspace(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  await page.waitForSelector('[aria-label="新建工作空间"]', { timeout: 15000 });
  await slow(page);

  await page.click('[aria-label="新建工作空间"]');
  await page.waitForSelector("#workspace-name");
  await slow(page);
  await page.fill("#workspace-name", name);
  await slow(page);

  await Promise.all([
    page.waitForSelector("#workspace-name", { state: "detached", timeout: 10000 }),
    page.click('button[type="submit"]'),
  ]);
  await slow(page);

  // 创建后可能跳转到了新对话页面，重新回到首页查看侧边栏
  await page.goto("/");
  await page.waitForSelector("button", { hasText: "新会话", timeout: 15000 });
  await slow(page);

  await page.waitForSelector(`[aria-label="在 ${name} 中新建对话"]`, { timeout: 15000 });
  await slow(page);
}

test.describe("工作空间管理", () => {
  test("删除工作空间", async ({ page }) => {
    const wsName = `DEL-${Date.now() % 100000}`;
    await createWorkspace(page, wsName);

    // 打开工作空间管理菜单
    const manageBtn = page.locator(`[aria-label="管理 ${wsName}"]`);
    await expect(manageBtn).toBeVisible({ timeout: 5000 });
    await manageBtn.click({ force: true });
    await slow(page);

    // 点击"移除"
    const deleteItem = page.locator('[data-slot="dropdown-menu-item"]', { hasText: "移除" });
    await expect(deleteItem).toBeVisible({ timeout: 5000 });
    await deleteItem.click();
    await slow(page);

    // 确认对话框出现
    await expect(
      page.locator('[data-slot="alert-dialog-title"]', { hasText: "确认移除工作空间？" })
    ).toBeVisible({ timeout: 5000 });
    await slow(page);

    // 点击确认删除
    const confirmBtn = page.locator('[data-slot="alert-dialog-action"]', { hasText: "移除" });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();
    await slow(page);

    // 工作空间不应该再出现
    await page.goto("/");
    await page.waitForSelector("button", { hasText: "新会话", timeout: 10000 });
    await slow(page);

    await expect(
      page.locator(`[aria-label="在 ${wsName} 中新建对话"]`)
    ).toBeHidden({ timeout: 5000 });
  });
});
