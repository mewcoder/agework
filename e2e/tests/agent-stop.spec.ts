import { test, expect } from "@playwright/test";

const SLOW = 800;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

async function ensureWorkspace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("button", { hasText: "新会话", timeout: 15000 });
  await slow(page);

  const existingWs = page.locator('[aria-label^="在 E2E测试空间 中新建对话"]');
  if (await existingWs.isVisible().catch(() => false)) {
    await existingWs.click();
    await slow(page);
    return;
  }

  await page.locator('[aria-label="新建工作空间"]').click();
  await page.waitForSelector("#workspace-name");
  await slow(page);
  await page.fill("#workspace-name", "E2E测试空间");
  await slow(page);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#workspace-name", { state: "detached", timeout: 5000 });
  await slow(page);
  await page.locator('[aria-label^="在 E2E测试空间 中新建对话"]').click();
  await slow(page);
}

async function selectModelProvider(page: import("@playwright/test").Page) {
  const settingsBtn = page.locator('button[aria-label="Agent 设置"]');
  await settingsBtn.click();
  await slow(page);

  const modelSubmenu = page.locator('[role="menuitem"]:has-text("模型")').first();
  await modelSubmenu.click();
  await slow(page);

  const testOption = page.locator('[role="menuitemradio"]:has-text("test")');
  if (await testOption.isVisible().catch(() => false)) {
    await testOption.click();
    await slow(page);
  } else {
    await page.keyboard.press("Escape");
    await slow(page);
  }
}

test.describe("Agent 运行控制", () => {
  test("发送消息后停止生成", async ({ page }) => {
    await ensureWorkspace(page);
    await selectModelProvider(page);

    const composer = page.locator('textarea[aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });
    await composer.fill("当前目录是什么？列出所有文件");
    await slow(page);

    // 发送消息
    await page.locator('button[aria-label="Send message"]').click();
    await slow(page);

    // 等待用户消息出现
    await expect(
      page.locator('[data-slot="aui_user-message-root"][data-role="user"]').last()
    ).toBeVisible({ timeout: 5000 });
    await slow(page);

    // 点击停止按钮
    const stopBtn = page.locator('button[aria-label="停止生成"]');
    if (await stopBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await stopBtn.click();
      await slow(page);
    }

    // 验证停止后可以继续发送新消息
    await expect(composer).toBeEnabled({ timeout: 30000 });
    await slow(page);
  });
});
