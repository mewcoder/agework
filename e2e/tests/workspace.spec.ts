import { test, expect } from "@playwright/test";

const SLOW = 800;
const WORKSPACE_NAME = `E2E空间-${Date.now()}`;

async function slow(page: import("@playwright/test").Page) {
  await page.waitForTimeout(SLOW);
}

test.describe("工作空间", () => {
  test("创建工作空间", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[aria-label="新建工作空间"]', { timeout: 15000 });
    await slow(page);

    await page.click('[aria-label="新建工作空间"]');
    await page.waitForSelector("#workspace-name");
    await slow(page);

    await page.fill("#workspace-name", WORKSPACE_NAME);
    await slow(page);

    await page.click('button[type="submit"]');
    await page.waitForSelector("#workspace-name", { state: "detached", timeout: 5000 });
    await slow(page);

    await expect(
      page.locator(`[aria-label="在 ${WORKSPACE_NAME} 中新建对话"]`)
    ).toBeVisible({ timeout: 10000 });
  });

  test("工作空间下新建对话", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(
      `[aria-label="在 ${WORKSPACE_NAME} 中新建对话"]`,
      { timeout: 15000 }
    );
    await slow(page);

    await page.locator(`[aria-label="在 ${WORKSPACE_NAME} 中新建对话"]`).click();
    await slow(page);

    await expect(page.locator('textarea[aria-label="Message input"]')).toBeVisible({
      timeout: 10000,
    });
  });
});
