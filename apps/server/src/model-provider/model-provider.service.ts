import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import {
  AGENT_TYPES,
  generateId,
  isAgentType,
  type AgentType,
} from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import { generateText } from "ai";
import { normalizeBaseUrl } from "../common/base-url";
import { getLLMClient } from "../common/llm";
import { ModelProviderRepository } from "./model-provider.repository";
import { getSystemStatus, type SystemStatus } from "./agent-cli-status";

// system:<agent> 是系统环境默认模型服务的固定 ID，走 agent CLI 本身的配置文件。
const SYSTEM_PREFIX = "system:";
const SYSTEM_MODEL_PROVIDER_NAME = "系统环境";
const MODEL_PROVIDER_SCOPE_SYSTEM = "system";
const MODEL_PROVIDER_SCOPE_GLOBAL = "global";

type ModelProviderScope = "system" | "global" | "user";
type ResolvedModelProvider =
  | { source: "system" }
  | { source: "custom"; providerConfig: ProviderConfig };
type ProviderConfigColumns = {
  baseUrl: string;
  apiKey: string;
  models: unknown;
  extraConfig: unknown;
};

function isSystemModelProviderId(id: string) {
  return id.startsWith(SYSTEM_PREFIX);
}

function systemModelProviderId(agentType: AgentType) {
  return `${SYSTEM_PREFIX}${agentType}`;
}

function agentTypeFromSystemModelProviderId(id: string): AgentType {
  const agentType = id.slice(SYSTEM_PREFIX.length);
  if (!isAgentType(agentType)) {
    throw new BadRequestException(`模型服务不可用: ${id}`);
  }
  return agentType;
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is string => typeof m === "string");
}

function normalizeExtraConfig(extraConfig: unknown): Record<string, string> {
  if (
    typeof extraConfig !== "object" ||
    extraConfig === null ||
    Array.isArray(extraConfig)
  ) {
    return {};
  }
  const entries = Object.entries(extraConfig).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

function toProviderConfig(row: ProviderConfigColumns): ProviderConfig {
  return {
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    models: normalizeModels(row.models),
    extraConfig: normalizeExtraConfig(row.extraConfig),
  };
}

/** desensitize=true 时（非 admin 的 listEnabled）把 apiKey 置空；
 * admin 的 listForAdmin 必须传 false——原样回显 apiKey，这是产品明确要求，不要改。 */
function serializeProviderConfig(
  row: ProviderConfigColumns,
  desensitize: boolean
): string {
  const config = toProviderConfig(row);
  return JSON.stringify(desensitize ? { ...config, apiKey: "" } : config);
}

@Injectable()
export class ModelProviderService implements OnModuleInit {
  constructor(private repo: ModelProviderRepository) {}

  async onModuleInit() {
    await Promise.all(
      AGENT_TYPES.map((agentType) => this.ensureSystemModelProvider(agentType))
    );
  }

  private async ensureSystemModelProvider(agentType: AgentType) {
    const id = systemModelProviderId(agentType);
    const placeholder = {
      agentType,
      scope: MODEL_PROVIDER_SCOPE_SYSTEM,
      userId: null,
      name: SYSTEM_MODEL_PROVIDER_NAME,
      baseUrl: "",
      apiKey: "",
      models: [] as string[],
      extraConfig: {} as Record<string, string>,
    };
    const existing = await this.repo.findById(id);
    if (existing) {
      const matchesPlaceholder =
        existing.agentType === agentType &&
        existing.scope === MODEL_PROVIDER_SCOPE_SYSTEM &&
        existing.userId === null &&
        existing.name === SYSTEM_MODEL_PROVIDER_NAME &&
        existing.baseUrl === "" &&
        existing.apiKey === "" &&
        normalizeModels(existing.models).length === 0 &&
        Object.keys(normalizeExtraConfig(existing.extraConfig)).length === 0;
      if (
        matchesPlaceholder &&
        existing.scope === MODEL_PROVIDER_SCOPE_SYSTEM
      ) {
        return existing;
      }
      return this.repo.update(id, placeholder);
    }

    return this.repo.create({ id, ...placeholder, isEnabled: false });
  }

  private validateBaseUrl(baseUrl: string) {
    try {
      normalizeBaseUrl(baseUrl);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : "无效的 baseUrl"
      );
    }
  }

  private async list(agentType: string, includeDisabled: boolean) {
    const resolvedAgentType = this.resolveAgentType(agentType);
    const modelProviders = await this.repo.findManyByAgent(
      resolvedAgentType,
      includeDisabled
    );
    const sorted = [...modelProviders].sort((a, b) => {
      const aSystem = isSystemModelProviderId(a.id);
      const bSystem = isSystemModelProviderId(b.id);
      if (aSystem !== bSystem) return aSystem ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    // desensitize: includeDisabled=true 代表走 admin 接口（listForAdmin），不脱敏；
    // includeDisabled=false 代表 listEnabled（非 admin），脱敏。
    const desensitize = !includeDisabled;
    return sorted.map((p) =>
      toModelProviderDto(
        {
          ...p,
          systemStatus: isSystemModelProviderId(p.id)
            ? getSystemStatus(p.agentType)
            : undefined,
        },
        desensitize
      )
    );
  }

  /** 列出指定 agent 类型下已启用的模型服务，供非 admin 调用方使用；返回结果脱敏（`apiKey` 置空）。 */
  async listEnabled(agentType: string) {
    const list = await this.list(agentType, false);
    return { list };
  }

  /** 列出指定 agent 类型下全部模型服务（含未启用），供 admin 管理端使用；原样回显 `apiKey`，不脱敏。 */
  async listForAdmin(agentType: string) {
    const list = await this.list(agentType, true);
    return { list };
  }

  /** 创建一个全局作用域的自定义模型服务；校验 baseUrl 合法性与同 scope 下名称唯一性。 */
  async create(
    agentType: string,
    name: string,
    providerConfig: ProviderConfig
  ) {
    const resolvedAgentType = this.resolveAgentType(agentType);
    const providerName = this.normalizeName(name);
    this.validateBaseUrl(providerConfig.baseUrl);
    await this.assertNameAvailable(
      resolvedAgentType,
      MODEL_PROVIDER_SCOPE_GLOBAL,
      null,
      providerName
    );
    const modelProvider = await this.repo.create({
      id: generateId(),
      agentType: resolvedAgentType,
      scope: MODEL_PROVIDER_SCOPE_GLOBAL,
      userId: null,
      name: providerName,
      isEnabled: true,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      models: providerConfig.models,
      extraConfig: providerConfig.extraConfig,
    });
    return toModelProviderDto(modelProvider, false);
  }

  /** 更新一个自定义模型服务的名称与配置；系统环境模型服务（id 以 `system:` 开头）不可更新。 */
  async update(
    modelProviderId: string,
    name: string,
    providerConfig: ProviderConfig
  ) {
    if (isSystemModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不可修改");
    const modelProvider = await this.repo.findById(modelProviderId);
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    this.validateBaseUrl(providerConfig.baseUrl);
    const providerName = this.normalizeName(name);
    await this.assertNameAvailable(
      modelProvider.agentType,
      modelProvider.scope,
      modelProvider.userId,
      providerName,
      modelProvider.id
    );
    const updated = await this.repo.update(modelProviderId, {
      name: providerName,
      baseUrl: providerConfig.baseUrl,
      apiKey: providerConfig.apiKey,
      models: providerConfig.models,
      extraConfig: providerConfig.extraConfig,
    });
    return toModelProviderDto(updated, false);
  }

  /** 启用/停用一个模型服务；系统环境模型服务会先确保 placeholder 记录存在，再写入启用状态。 */
  async setEnabled(modelProviderId: string, isEnabled: boolean) {
    if (isSystemModelProviderId(modelProviderId)) {
      const agentType = agentTypeFromSystemModelProviderId(modelProviderId);
      await this.ensureSystemModelProvider(agentType);
      const updated = await this.repo.update(modelProviderId, { isEnabled });
      return toModelProviderDto(updated, false);
    }

    const modelProvider = await this.repo.findById(modelProviderId);
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    const updated = await this.repo.update(modelProviderId, { isEnabled });
    return toModelProviderDto(updated, false);
  }

  /**
   * 供 agent 模块解析运行所需的模型服务：系统/自定义都以数据库启用状态为准。
   * 系统配置不携带 ProviderConfig；未找到/不可用返回 null，由调用方决定如何报错。
   */
  async resolveEnabledProvider(
    agentType: string,
    modelProviderId: string
  ): Promise<ResolvedModelProvider | null> {
    const modelProvider = await this.repo.findEnabled(
      modelProviderId,
      agentType
    );
    if (!modelProvider) return null;
    if (modelProvider.scope === MODEL_PROVIDER_SCOPE_SYSTEM) {
      return { source: "system" };
    }
    return {
      source: "custom",
      providerConfig: toProviderConfig(modelProvider),
    };
  }

  /** 删除一个自定义模型服务；系统环境不可删除，启用中的模型服务须先停用才能删除。 */
  async delete(modelProviderId: string) {
    if (isSystemModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不可删除");
    const modelProvider = await this.repo.findById(modelProviderId);
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    if (modelProvider.isEnabled)
      throw new BadRequestException("启用中的模型服务不可删除，请先停用");
    await this.repo.delete(modelProviderId);
  }

  /** 对一个自定义模型服务发起一次最小生成请求，探测连通性/鉴权是否可用；系统环境不支持连通性测试。 */
  async ping(
    modelProviderId: string,
    includeDisabled = false
  ): Promise<{ success: boolean; latency: number; error?: string }> {
    if (isSystemModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不支持连通性测试");

    const modelProvider = await this.repo.findById(modelProviderId);
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    if (!includeDisabled && !modelProvider.isEnabled)
      throw new BadRequestException(`模型服务不可用: ${modelProviderId}`);

    const providerConfig = toProviderConfig(modelProvider);
    const agentType = modelProvider.agentType as AgentType;

    const built = getLLMClient(agentType, providerConfig);
    if ("error" in built) {
      return { success: false, latency: 0, error: built.error };
    }

    // 通过 ai-sdk 发起一次最小生成作为连通性/鉴权探测。
    const start = Date.now();
    try {
      await generateText({
        model: built.model,
        prompt: "hi",
        maxOutputTokens: 1,
        temperature: 0,
        maxRetries: 0,
        timeout: 10000,
      });
      return { success: true, latency: Date.now() - start };
    } catch (err: unknown) {
      return {
        success: false,
        latency: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private resolveAgentType(agentType: string): AgentType {
    if (!isAgentType(agentType)) {
      throw new BadRequestException(`不支持的 agent 类型: ${agentType}`);
    }
    return agentType;
  }

  private normalizeName(name: string): string {
    const trimmed = name?.trim();
    if (!trimmed) throw new BadRequestException("name is required");
    return trimmed;
  }

  private async assertNameAvailable(
    agentType: string,
    scope: string,
    userId: string | null,
    name: string,
    excludeId?: string
  ) {
    const existing = await this.repo.findIdByName({
      agentType,
      scope,
      userId,
      name,
      excludeId,
    });
    if (existing) {
      throw new BadRequestException(`模型服务名称已存在: ${name}`);
    }
  }
}

function toModelProviderDto(
  modelProvider: ProviderConfigColumns & {
    id: string;
    agentType: string;
    scope: string;
    userId: string | null;
    name: string;
    isEnabled: boolean;
    systemStatus?: SystemStatus;
    createdAt: Date | string;
    updatedAt: Date | string;
  },
  desensitize: boolean
) {
  return {
    modelProviderId: modelProvider.id,
    agentType: modelProvider.agentType,
    scope: modelProvider.scope as ModelProviderScope,
    userId: modelProvider.userId,
    name: modelProvider.name,
    isEnabled: modelProvider.isEnabled,
    providerConfig: serializeProviderConfig(modelProvider, desensitize),
    ...(modelProvider.systemStatus
      ? { systemStatus: modelProvider.systemStatus }
      : {}),
    createdAt:
      modelProvider.createdAt instanceof Date
        ? modelProvider.createdAt.toISOString()
        : modelProvider.createdAt,
    updatedAt:
      modelProvider.updatedAt instanceof Date
        ? modelProvider.updatedAt.toISOString()
        : modelProvider.updatedAt,
  };
}
