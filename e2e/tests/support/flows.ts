import { expect, type Page } from "@playwright/test";
import { MOCK_PROVIDER_NAME } from "./mock-provider";

export const E2E_WORKSPACE_NAME = "E2E测试空间";

const SLOW = 500;

async function pause(page: Page) {
  await page.waitForTimeout(SLOW);
}

/** 打开首页(落地 composer),等输入框就绪。 */
export async function gotoHome(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator('textarea[aria-label="消息输入"]')).toBeVisible({
    timeout: 15_000,
  });
  await pause(page);
}

/**
 * 在落地页 composer 的工作空间选择器里选中 E2E 工作空间;
 * 不存在则经"添加工作空间"对话框创建(创建后自动选中)。
 */
export async function ensureWorkspaceSelected(page: Page): Promise<void> {
  const picker = page.getByRole("combobox", { name: "选择工作空间" });
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await picker.click();
  await pause(page);

  const existing = page.getByRole("option", { name: E2E_WORKSPACE_NAME });
  if (await existing.isVisible().catch(() => false)) {
    await existing.click();
    await pause(page);
    return;
  }

  await page.getByRole("option", { name: "添加工作空间" }).click();
  await page.waitForSelector("#workspace-name");
  await page.fill("#workspace-name", E2E_WORKSPACE_NAME);
  await pause(page);
  await page.click('button[type="submit"]');
  await page.waitForSelector("#workspace-name", {
    state: "detached",
    timeout: 10_000,
  });
  await pause(page);
}

/**
 * 在 composer 的「模型与推理设置」菜单里选中 mock 模型 provider(名为 test)。
 * provider 由 ensureMockProvider 预先创建;选不到即真失败,不静默回退。
 */
export async function selectMockModel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "模型与推理设置" }).click();
  await pause(page);
  await page.getByRole("menuitem", { name: /^配置/ }).click();
  await pause(page);
  const option = page.getByRole("menuitemradio", {
    name: MOCK_PROVIDER_NAME,
    exact: true,
  });
  await expect(option).toBeVisible({ timeout: 5_000 });
  await option.click();
  await pause(page);
  // 菜单若未随选择关闭,按 Esc 收起,避免遮挡 composer
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await pause(page);
}

/** 填入消息并发送(落地页与会话页 composer 同标签),等待进入会话路由。 */
export async function sendMessage(page: Page, text: string): Promise<void> {
  const composer = page.locator('textarea[aria-label="消息输入"]');
  await composer.fill(text);
  await pause(page);
  const send = page.locator('button[aria-label="发送消息"]');
  await expect(send).toBeEnabled({ timeout: 5_000 });
  await send.click();
  await expect(page).toHaveURL(/\/c\//, { timeout: 30_000 });
}

/** 等待 assistant 回复出现且非空;页面报错则直接失败。 */
export async function waitForAgentReply(page: Page): Promise<void> {
  const errorMessage = page.locator('.aui-message-error-root, [role="alert"]');
  const assistantMessage = page.locator(
    '[data-slot="aui_assistant-message-root"][data-role="assistant"]'
  );

  await page.waitForTimeout(1_000);
  if ((await errorMessage.count()) > 0) {
    throw new Error(`Agent 返回了错误: ${await errorMessage.first().innerText()}`);
  }

  await expect(assistantMessage.last()).toBeVisible({ timeout: 60_000 });
  const content = assistantMessage
    .last()
    .locator('[data-slot="aui_assistant-message-content"]');
  await expect(content).not.toBeEmpty({ timeout: 10_000 });
}
