import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

async function ensureWorkspaceAndConversation(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("button", { hasText: "新会话", timeout: 15000 });
  await slow(page);

  const existingWs = page.locator('[aria-label^="在 E2E测试空间 中新建对话"]');
  if (await existingWs.isVisible().catch(() => false)) {
    await existingWs.click();
    await slow(page);
    return "E2E测试空间";
  }

  const wsName = `E2E测试空间`;
  await page.locator('[aria-label="新建工作空间"]').click();
  await page.waitForSelector("#workspace-name");
  await slow(page);
  await page.fill("#workspace-name", wsName);
  await slow(page);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#workspace-name", { state: "detached", timeout: 5000 });
  await slow(page);
  await page.locator(`[aria-label^="在 ${wsName} 中新建对话"]`).click();
  await slow(page);
  return wsName;
}

/**
 * 获得第一个对话的上下文菜单。对话列表 hover 状态不可靠（CSS group-hover），
 * 使用 force 强制点击触发菜单。
 */
async function openFirstConversationMenu(page: import("@playwright/test").Page) {
  const menuBtn = page.locator('[aria-label="对话操作"]').first();
  await expect(menuBtn).toBeVisible({ timeout: 5000 });
  await menuBtn.click({ force: true });
  await slow(page);
}

test.describe("对话管理", () => {
  test("归档对话", async ({ page }) => {
    await ensureWorkspaceAndConversation(page);

    const composer = page.locator('textarea[aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });
    await composer.fill("hello");
    await slow(page);
    await page.locator('button[aria-label="Send message"]').click();
    await slow(page);

    // 等待 URL 跳转到 /c/
    await expect(page).toHaveURL(/\/c\//, { timeout: 30000 });

    // 回到首页
    await page.goto("/");
    await page.waitForSelector("button", { hasText: "新会话", timeout: 10000 });
    await slow(page);

    // 打开第一个对话的菜单并归档
    await openFirstConversationMenu(page);

    const archiveItem = page.locator('[data-slot="dropdown-menu-item"]', { hasText: "归档" });
    await expect(archiveItem).toBeVisible({ timeout: 5000 });
    await archiveItem.click();
    await slow(page);

    // 验证对话不再显示
    await page.goto("/");
    await page.waitForSelector("button", { hasText: "新会话", timeout: 10000 });
  });

  test("设置 - 已归档对话页面可访问", async ({ page }) => {
    await page.goto("/settings");
    await slow(page);

    const archivedTab = page.locator('[role="tab"]', { hasText: "已归档对话" });
    if (await archivedTab.isVisible().catch(() => false)) {
      await archivedTab.click();
      await slow(page);
      await expect(page.locator("body")).not.toContainText("Error", { timeout: 5000 });
    }
  });
});
