import { request } from "@playwright/test";

/** 与 playwright.config.ts webServer 保持一致的后端地址。
 *  注意 baseURL 不能带路径段:以 / 开头的请求路径会把它整段吞掉。 */
const API_BASE_URL = "http://localhost:3000";
const API_PREFIX = "/api/v1";

/** e2e 专用 mock 模型 provider 的名字（selectModelProvider 按它选中）。 */
export const MOCK_PROVIDER_NAME = "test";

/**
 * 确保存在名为 `test` 的 mock 模型 provider（baseUrl=mock://e2e）。
 * worker 对 `mock:` scheme 返回确定性 mock 执行器（回显 / [slow] 慢流），
 * 使 agent-run / cancel 用例不依赖真实模型 key、可在 CI 稳定复现。
 * 幂等：已存在则不再创建。
 */
export async function ensureMockProvider(): Promise<void> {
  const api = await request.newContext({ baseURL: API_BASE_URL });
  try {
    const listResponse = await api.get(
      `${API_PREFIX}/admin/model-providers/list?agentType=claude`
    );
    if (!listResponse.ok()) {
      throw new Error(
        `list model providers failed: ${listResponse.status()} ${await listResponse.text()}`
      );
    }
    const body = (await listResponse.json()) as {
      data?: { list?: Array<{ name?: string }> };
    };
    const exists = body.data?.list?.some(
      (provider) => provider.name === MOCK_PROVIDER_NAME
    );
    if (exists) return;

    const createResponse = await api.post(
      `${API_PREFIX}/admin/model-providers/create`,
      {
      data: {
        agentType: "claude",
        name: MOCK_PROVIDER_NAME,
        providerConfig: {
          baseUrl: "mock://e2e",
          apiKey: "mock-key",
          models: ["mock-model"],
          extraConfig: {},
        },
      },
    });
    if (!createResponse.ok()) {
      throw new Error(
        `create mock provider failed: ${createResponse.status()} ${await createResponse.text()}`
      );
    }
  } finally {
    await api.dispose();
  }
}
