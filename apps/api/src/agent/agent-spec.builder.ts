import { Injectable, BadRequestException } from "@nestjs/common";
import type { ProviderConfig } from "@agework/shared/api";
import type { AdapterRuntimeConfig } from "@agework/shared/protocol";
import { ModelProviderService } from "../model-providers/model-provider.service";
import type { AgentSpec } from "../runs/run-service.types";

@Injectable()
export class AgentSpecBuilder {
  constructor(private readonly modelProviderService: ModelProviderService) {}

  async build(params: {
    agentType: string;
    modelProviderId: string;
    model?: string;
  }): Promise<AgentSpec> {
    const { agentType, modelProviderId, model } = params;

    const resolved = await this.modelProviderService.resolveEnabledConfig(
      agentType,
      modelProviderId
    );
    if (!resolved) {
      throw new BadRequestException(`模型服务不可用: ${modelProviderId}`);
    }

    const adapter = buildAdapter(agentType, resolved, model);

    return { agentType, adapter };
  }
}

function buildAdapter(
  agentType: string,
  resolved: {
    providerConfig: ProviderConfig;
    providerSource: "environment" | "database";
  },
  requestedModel?: string
): AdapterRuntimeConfig {
  const kind = resolveAdapterKind(agentType);
  if (resolved.providerSource === "environment") {
    return { kind, isEnvironmentConfig: true };
  }

  const { baseUrl, apiKey, models, extraConfig } = resolved.providerConfig;
  if (!baseUrl || !apiKey || models.length === 0) {
    const label = kind === "claude" ? "Claude" : "Codex";
    throw new BadRequestException(
      `${label} 自定义配置缺少 baseUrl/apiKey/models`
    );
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
