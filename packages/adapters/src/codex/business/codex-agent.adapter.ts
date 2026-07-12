import { Logger } from "@nestjs/common";
import { tmpdir } from "os";
import { join } from "path";
import { CodexAgentAdapter as AgUiCodexAgentAdapter } from "../base";
import type { AgentTraceSink } from "@agework/shared/protocol";
import { pickSafeEnv } from "../../common/safe-env";

const logger = new Logger("CodexAgentAdapter");

const PROVIDER_NAME = "_agework";

export type CodexAdapterConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  cwd?: string;
  modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  trace?: AgentTraceSink;
  /** 直接传入 Codex --config 覆盖，例如禁用插件: { plugins: { "browser@openai-bundled": { enabled: false } } } */
  extraConfig?: Record<string, unknown>;
};

export class CodexAgentAdapter extends AgUiCodexAgentAdapter {
  constructor(opts: CodexAdapterConfig = {}) {
    const workdir = opts.cwd;
    // model_providers.X.base_url 不需要 /v1
    const baseUrl = opts.baseUrl?.replace(/\/$/, "").replace(/\/v1$/, "");

    logger.log(
      `workdir=${workdir ?? "(not set)"}, ` +
        `baseUrl=${baseUrl ?? "(not set)"}, ` +
        `model=${opts.model ?? "(not set)"}, ` +
        `apiKey=${opts.apiKey ? opts.apiKey.slice(0, 8) + "..." : "(not set)"}`
    );

    // 通过 config 注入完整 provider 定义，覆盖全局 config.toml 中的 model_provider
    // wire_api="responses" 使用 HTTP 而非 WebSocket，避免代理不支持 WebSocket 导致断连
    const providerConfig = baseUrl
      ? {
          model_provider: PROVIDER_NAME,
          model_providers: {
            [PROVIDER_NAME]: {
              name: "OpenAI",
              base_url: baseUrl,
              wire_api: "responses",
              requires_openai_auth: true,
            },
          },
        }
      : undefined;

    const config =
      providerConfig || opts.extraConfig
        ? { ...providerConfig, ...opts.extraConfig }
        : undefined;

    // Windows sandbox 只允许写入工作目录和 TEMP 目录，
    // npm 默认缓存路径 %LOCALAPPDATA%\npm-cache 不可写，
    // npm 会回退到在当前工作目录下创建 npm-cache 文件夹。
    // 注入 NPM_CONFIG_CACHE 指向 TEMP 目录（sandbox 允许写入），避免污染项目目录。
    const npmCacheDir = join(tmpdir(), "npm-cache-agent-runtime");

    super({
      apiKey: opts.apiKey,
      model: opts.model,
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      modelReasoningEffort: opts.modelReasoningEffort,
      config,
      trace: opts.trace,
      env: {
        ...pickSafeEnv({ includeClaudeEnv: false }),
        NPM_CONFIG_CACHE: npmCacheDir,
      },
    });
  }

  /**
   * SDK backend does not support HITL approvals (【决策8】 — SDK is a
   * fallback with auto-approve only). This method always returns false
   * to indicate no pending approval was found.
   */
  resolveApproval(): boolean {
    return false;
  }
}
