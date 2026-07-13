import { test, expect } from "@playwright/test";
import { ensureMockProvider } from "./support/mock-provider";

const SLOW = 800;

// mock provider 的 [slow] 模式会持续输出约 30s,给"停止生成"留出确定性取消窗口
test.beforeAll(async () => {
  await ensureMockProvider();
});

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

  // mock provider 由 beforeAll 保证存在;选不到就该失败,不再静默回退默认模型
  const testOption = page.locator('[role="menuitemradio"]:has-text("test")');
  await expect(testOption).toBeVisible({ timeout: 5000 });
  await testOption.click();
  await slow(page);
}

test.describe("Agent 运行控制", () => {
  test("发送消息后停止生成", async ({ page }) => {
    await ensureWorkspace(page);
    await selectModelProvider(page);

    const composer = page.locator('textarea[aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });
    // [slow] 让 mock 模型持续输出约 30s,取消窗口是确定的
    await composer.fill("请慢慢说 [slow]");
    await slow(page);

    // 发送消息
    await page.locator('button[aria-label="Send message"]').click();
    await slow(page);

    // 等待用户消息出现
    await expect(
      page.locator('[data-slot="aui_user-message-root"][data-role="user"]').last()
    ).toBeVisible({ timeout: 5000 });
    await slow(page);

    // 停止按钮必须出现并被点击——mock 流足够长,不出现即为真失败,不再静默跳过
    const stopBtn = page.locator('button[aria-label="停止生成"]');
    await expect(stopBtn).toBeVisible({ timeout: 10000 });
    await stopBtn.click();

    // 取消语义:停止按钮消失(run 不再运行),composer 恢复可用
    await expect(stopBtn).toBeHidden({ timeout: 15000 });
    await expect(composer).toBeEnabled({ timeout: 15000 });
    await slow(page);
  });
});
