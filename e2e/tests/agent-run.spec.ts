import { test, expect } from "@playwright/test";
import { ensureMockProvider } from "./support/mock-provider";
import {
  ensureWorkspaceSelected,
  gotoHome,
  selectMockModel,
  sendMessage,
  waitForAgentReply,
} from "./support/flows";

// mock 模型 provider(baseUrl=mock://e2e)在套件开跑前就位:
// agent 回复由 worker 的 MockAgentDriver 确定性生成,不依赖真实模型 key。
test.beforeAll(async () => {
  await ensureMockProvider();
});

test.describe("Agent Run 全链路", () => {
  test("发送消息 → Agent 回复", async ({ page }) => {
    await gotoHome(page);
    await ensureWorkspaceSelected(page);
    await selectMockModel(page);

    await sendMessage(page, "hello e2e");

    const userMessage = page.locator(
      '[data-slot="aui_user-message-root"][data-role="user"]'
    );
    await expect(userMessage.last()).toBeVisible({ timeout: 10_000 });

    await waitForAgentReply(page);

    // mock 模型的回复是确定性的,可做强断言(真实模型只能断言非空)
    const reply = page
      .locator('[data-slot="aui_assistant-message-root"][data-role="assistant"]')
      .last()
      .locator('[data-slot="aui_assistant-message-content"]');
    await expect(reply).toContainText("mock reply: hello e2e", {
      timeout: 15_000,
    });
  });

  test("对话 URL 正确更新", async ({ page }) => {
    await gotoHome(page);
    await ensureWorkspaceSelected(page);
    await selectMockModel(page);

    await sendMessage(page, "url check");
    await expect(page).toHaveURL(/\/c\//);
  });

  test("多轮对话", async ({ page }) => {
    await gotoHome(page);
    await ensureWorkspaceSelected(page);
    await selectMockModel(page);

    await sendMessage(page, "round one");
    await waitForAgentReply(page);

    const composer = page.locator('textarea[aria-label="消息输入"]');
    await expect(composer).toBeEnabled({ timeout: 15_000 });
    await composer.fill("round two");
    const send = page.locator('button[aria-label="发送消息"]');
    await expect(send).toBeEnabled({ timeout: 10_000 });
    await send.click();

    const userMessages = page.locator(
      '[data-slot="aui_user-message-root"][data-role="user"]'
    );
    await expect(userMessages).toHaveCount(2, { timeout: 15_000 });
    await waitForAgentReply(page);
  });
});
