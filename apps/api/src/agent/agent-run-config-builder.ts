import { Injectable, BadRequestException } from "@nestjs/common";
import { join, posix } from "node:path";
import type { AgentType } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import type { RunConfig, AdapterRuntimeConfig, RuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import { CONTAINER_RUNTIME_LOG_DIR } from "../config/defaults";
import { EnvKey } from "../config/env-key";
import { ModelProviderService } from "../model-providers/model-provider.service";
import { safePathPart } from "../common/safe-path";

const DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB = 50;

@Injectable()
export class AgentRunConfigBuilder {
  constructor(
    private readonly modelProviderService: ModelProviderService,
    private readonly configService: ConfigService
  ) {}

  async buildRunConfig(params: {
    agentType: string;
    modelProviderId: string;
    workspaceId: string;
    placement: RuntimePlacement;
    runId: string;
    conversationId: string;
    input: unknown;
    model?: string;
  }): Promise<RunConfig> {
    const {
      agentType,
      modelProviderId,
      workspaceId,
      placement,
      runId,
      conversationId,
      input,
      model,
    } = params;

    const resolved = await this.modelProviderService.resolveEnabledConfig(
      agentType,
      modelProviderId
    );
    if (!resolved) {
      throw new BadRequestException(`模型服务不可用: ${modelProviderId}`);
    }

    const adapter = buildAdapter(agentType, resolved, model);

    const logPaths = buildRuntimeLogPaths({
      placement,
      logDir: this.configService.getRuntimeLogDir(),
      conversationId,
    });

    return {
      runId,
      conversationId,
      workspaceId,
      agentType: agentType as AgentType,
      runtimePath: placement.runtimePath,
      env: {},
      input,
      adapter,
      agentEventTrace: buildAgentEventTraceConfig({
        runId,
        conversationId,
        workspaceId,
        agentType,
        ...logPaths,
      }),
      workerLogFilePath: logPaths.workerRuntimeFilePath,
    };
  }
}

function buildAdapter(
  agentType: string,
  resolved: { providerConfig: ProviderConfig; providerSource: "environment" | "database" },
  requestedModel?: string,
): AdapterRuntimeConfig {
  const kind = resolveAdapterKind(agentType);
  if (resolved.providerSource === "environment") {
    return { kind, isEnvironmentConfig: true };
  }

  const { baseUrl, apiKey, models, extraConfig } = resolved.providerConfig;
  if (!baseUrl || !apiKey || models.length === 0) {
    const label = kind === "claude" ? "Claude" : "Codex";
    throw new BadRequestException(`${label} 自定义配置缺少 baseUrl/apiKey/models`);
  }
  // model 由前端选定并传入，后端不兜底取 models[0]；缺失或不在可用列表中即报错。
  if (!requestedModel || !models.includes(requestedModel)) {
    throw new BadRequestException("未选择模型或模型不在可用列表中");
  }
  const model = requestedModel;

  return {
    kind,
    isEnvironmentConfig: false,
    baseUrl,
    apiKey,
    model,
    ...(Object.keys(extraConfig).length > 0 ? { extraConfig } : {}),
  };
}

function resolveAdapterKind(agentType: string): "claude" | "codex" {
  if (agentType !== "claude" && agentType !== "codex") {
    throw new BadRequestException(`不支持的 agent 类型: ${agentType}`);
  }
  return agentType;
}

// AGEWORK_AGENT_EVENT_TRACE_ENABLED 只控制 raw/agui 大 payload 是否落 JSONL 文件（"trace" 这里指完整证据，
// 不是事件索引）。DB 关键事件索引（RunEventRecorder 写入的 RunEvent）与本开关无关，始终记录，
// 关闭本开关后 run 仍可在管理端看到事件摘要，只是看不到完整 raw/agui payload 原文。
function buildAgentEventTraceConfig(input: {
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
  logDir: string;
  rawFilePath: string;
  rawRuntimeFilePath: string;
  aguiFilePath: string;
}) {
  const enabled = isTruthy(process.env[EnvKey.AGENT_EVENT_TRACE_ENABLED]);
  const maxFileMb = parsePositiveInt(
    process.env[EnvKey.AGENT_EVENT_TRACE_MAX_FILE_MB],
    DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB
  );

  return {
    enabled,
    logDir: enabled ? input.logDir : undefined,
    rawFilePath: enabled ? input.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? input.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? input.aguiFilePath : undefined,
    maxFileMb,
    runId: input.runId,
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    agentType: input.agentType,
  };
}

function buildRuntimeLogPaths(input: {
  placement: RuntimePlacement;
  logDir: string;
  conversationId: string;
}) {
  const conversationFileName = safePathPart(input.conversationId);
  const rawFileName = `${conversationFileName}.raw.jsonl`;
  const aguiFileName = `${conversationFileName}.agui.jsonl`;
  const workerFileName = `${conversationFileName}.worker.log`;
  const isSandbox = ["sandbox", "docker", "opensandbox"].includes(
    input.placement.runtimeType
  );

  return {
    logDir: input.logDir,
    rawFilePath: join(input.logDir, rawFileName),
    rawRuntimeFilePath: isSandbox
      ? posix.join(CONTAINER_RUNTIME_LOG_DIR, rawFileName)
      : join(input.logDir, rawFileName),
    aguiFilePath: join(input.logDir, aguiFileName),
    workerRuntimeFilePath: isSandbox
      ? posix.join(CONTAINER_RUNTIME_LOG_DIR, workerFileName)
      : join(input.logDir, workerFileName),
  };
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
