import { test, expect } from "@playwright/test";
import { ensureMockProvider } from "./support/mock-provider";

const SLOW = 800;

// mock 模型 provider（baseUrl=mock://e2e）在套件开跑前就位:
// agent 回复由 worker 的 MockAgentDriver 确定性生成,不依赖真实模型 key。
test.beforeAll(async () => {
  await ensureMockProvider();
});

function sendBtn(page: import("@playwright/test").Page) {
  return page.locator('button[aria-label="Send message"]');
}

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
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

  await page.locator('button[aria-label="新建工作空间"]').click();
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

async function waitForAgentReply(page: import("@playwright/test").Page) {
  const errorMessage = page.locator('.aui-message-error-root, [role="alert"]');
  const assistantMessage = page.locator(
    '[data-slot="aui_assistant-message-root"][data-role="assistant"]'
  );

  await page.waitForTimeout(2000);

  const errorCount = await errorMessage.count();
  if (errorCount > 0) {
    const errorText = await errorMessage.first().innerText();
    throw new Error(`Agent 返回了错误: ${errorText}`);
  }

  await expect(assistantMessage.last()).toBeVisible({ timeout: 90_000 });

  const content = assistantMessage.last().locator(
    '[data-slot="aui_assistant-message-content"]'
  );
  await expect(content).not.toBeEmpty({ timeout: 10000 });

  const text = await content.innerText();
  if (!text.trim()) {
    throw new Error("Agent 回复内容为空");
  }
}

test.describe("Agent Run 全链路", () => {
  test("发送消息 → Agent 回复", async ({ page }) => {
    await ensureWorkspace(page);
    await selectModelProvider(page);

    const composer = page.locator('textarea[aria-label="Message input"]');
    await expect(composer).toBeVisible({ timeout: 10000 });
    await slow(page);

    await composer.fill("hello e2e");
    await slow(page);

    await expect(sendBtn(page)).toBeEnabled({ timeout: 5000 });
    await sendBtn(page).click();

    const userMessage = page.locator(
      '[data-slot="aui_user-message-root"][data-role="user"]'
    );
    await expect(userMessage.last()).toBeVisible({ timeout: 5000 });
    await slow(page);

    await waitForAgentReply(page);

    // mock 模型的回复是确定性的,可做强断言(真实模型只能断言非空)
    const reply = page
      .locator('[data-slot="aui_assistant-message-root"][data-role="assistant"]')
      .last()
      .locator('[data-slot="aui_assistant-message-content"]');
    await expect(reply).toContainText("mock reply: hello e2e");
  });

  test("对话 URL 正确更新", async ({ page }) => {
    await ensureWorkspace(page);
    await selectModelProvider(page);

    const composer = page.locator('textarea[aria-label="Message input"]');
    await composer.fill("当前目录是什么？");
    await slow(page);
    await sendBtn(page).click();

    await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
  });

  test("多轮对话", async ({ page }) => {
    await ensureWorkspace(page);
    await selectModelProvider(page);

    const composer = page.locator('textarea[aria-label="Message input"]');

    await composer.fill("当前目录是什么？");
    await slow(page);
    await sendBtn(page).click();

    await waitForAgentReply(page);
    await slow(page);

    const refreshBtn = page.locator('button', { hasText: "Refresh" });
    if (await refreshBtn.isVisible().catch(() => false)) {
      await refreshBtn.click();
      await slow(page);
    }

    await composer.fill("列出当前目录的文件");
    await slow(page);

    const sendButton = sendBtn(page);
    if (await sendButton.isEnabled().catch(() => false)) {
      await sendButton.click();
      const userMessages = page.locator(
        '[data-slot="aui_user-message-root"][data-role="user"]'
      );
      await expect(userMessages).toHaveCount(2, { timeout: 10_000 });
    }
  });
});
