import { test, expect } from "@playwright/test";
import { ensureMockProvider } from "./support/mock-provider";
import {
  ensureWorkspaceSelected,
  gotoHome,
  selectMockModel,
  sendMessage,
} from "./support/flows";

// mock provider 的 [slow] 模式会持续输出约 30s,给"停止生成"留出确定性取消窗口
test.beforeAll(async () => {
  await ensureMockProvider();
});

test.describe("Agent 运行控制", () => {
  test("发送消息后停止生成", async ({ page }) => {
    await gotoHome(page);
    await ensureWorkspaceSelected(page);
    await selectMockModel(page);

    // [slow] 让 mock 模型持续输出约 30s,取消窗口是确定的
    await sendMessage(page, "请慢慢说 [slow]");

    await expect(
      page
        .locator('[data-slot="aui_user-message-root"][data-role="user"]')
        .last()
    ).toBeVisible({ timeout: 10_000 });

    // 停止按钮必须出现并被点击——mock 流足够长,不出现即为真失败,不再静默跳过
    const stopBtn = page.locator('button[aria-label="停止生成"]');
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });
    await stopBtn.click();

    // 取消语义:停止按钮消失(run 不再运行),composer 恢复可用
    await expect(stopBtn).toBeHidden({ timeout: 15_000 });
    await expect(
      page.locator('textarea[aria-label="消息输入"]')
    ).toBeEnabled({ timeout: 15_000 });
  });
});
