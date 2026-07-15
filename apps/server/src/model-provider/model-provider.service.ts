import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { generateId, isAgentType, type AgentType } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import { generateText } from "ai";
import { normalizeBaseUrl } from "../common/base-url";
import { ConfigService } from "../config/config.service";
import { getLLMClient } from "../common/llm";
import { RuntimeHostService } from "../runtime-host/runtime-host.service";
import { ModelProviderRepository } from "./model-provider.repository";

const SYSTEM_MODEL_PROVIDER_ID = "system";
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
  return id === SYSTEM_MODEL_PROVIDER_ID;
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
export class ModelProviderService {
  constructor(
    private repo: ModelProviderRepository,
    private configService: ConfigService,
    private runtimeHostService: RuntimeHostService
  ) {}

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
    // desensitize: includeDisabled=true 代表走 admin 接口（listForAdmin），不脱敏；
    // includeDisabled=false 代表 listEnabled（非 admin），脱敏。
    const desensitize = !includeDisabled;
    return modelProviders.map((p) => toModelProviderDto(p, desensitize));
  }

  /** 列出指定 agent 类型下已启用的模型服务，供非 admin 调用方使用；返回结果脱敏（`apiKey` 置空）。
   *
   * 「系统环境」模型配置的可见性由两层 AND 决定（见 runtime 模块 CONTEXT.md）：
   * 1. admin 全局开关 SYSTEM_ENV_ENABLED
   * 2. 传入 runtimeHostId 时，该 runtime 的 envConfig 检测到对应 agent 的 CLI（resolvedPath != null）
   * 未传 runtimeHostId 时（如设置页）只检查开关，不做 runtime 检测。
   * 系统环境不再作为数据库记录存在，开关打开时直接构造虚拟 DTO 返回。 */
  async listEnabled(agentType: string, runtimeHostId?: string) {
    const resolvedAgentType = this.resolveAgentType(agentType);
    const systemAvailable = await this.isSystemEnvAvailable(
      resolvedAgentType,
      runtimeHostId
    );

    // 获取已启用的自定义模型服务
    const enabledProviders = await this.repo.findManyByAgent(
      resolvedAgentType,
      false
    );

    // 开关打开时，构造虚拟的系统环境 DTO 加入列表
    const customDtos = enabledProviders.map((p) => toModelProviderDto(p, true));

    const result = systemAvailable
      ? [buildSystemModelProviderDto(resolvedAgentType), ...customDtos]
      : customDtos;

    return { list: result };
  }

  /** 系统环境可用性判断：admin 全局开关 AND（传入 runtimeHostId 时）runtime 检测到 CLI。 */
  private async isSystemEnvAvailable(
    agentType: AgentType,
    runtimeHostId?: string
  ): Promise<boolean> {
    if (!this.configService.isSystemEnvEnabled()) return false;
    if (!runtimeHostId) return true;

    const cliPaths =
      await this.runtimeHostService.getResolvedCliPaths(runtimeHostId);
    if (!cliPaths) return false;
    const resolvedPath = cliPaths[agentType];
    return !!resolvedPath;
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

  /** 更新一个自定义模型服务的名称与配置；系统环境模型服务（id 为 `system`）不可更新。 */
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

  /** 启用/停用一个模型服务；系统环境不可通过模型服务管理启用/停用，请使用系统配置开关。 */
  async setEnabled(modelProviderId: string, isEnabled: boolean) {
    if (isSystemModelProviderId(modelProviderId)) {
      throw new BadRequestException(
        "系统环境不可通过模型服务管理启用/停用，请使用系统配置开关 AGEWORK_SYSTEM_ENV_ENABLED"
      );
    }

    const modelProvider = await this.repo.findById(modelProviderId);
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    const updated = await this.repo.update(modelProviderId, { isEnabled });
    return toModelProviderDto(updated, false);
  }

  /**
   * 供 agent 模块解析运行所需的模型服务。
   * 系统环境（id 为 `system`）不再查数据库，直接根据系统配置开关判断可用性。
   * 自定义模型服务仍以数据库启用状态为准。
   * 未找到/不可用返回 null，由调用方决定如何报错。
   */
  async resolveEnabledProvider(
    agentType: string,
    modelProviderId: string
  ): Promise<ResolvedModelProvider | null> {
    if (isSystemModelProviderId(modelProviderId)) {
      return this.configService.isSystemEnvEnabled()
        ? { source: "system" }
        : null;
    }

    const modelProvider = await this.repo.findEnabled(
      modelProviderId,
      agentType
    );
    if (!modelProvider) return null;
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

/** 构造虚拟的系统环境模型服务 DTO（不依赖数据库记录），开关打开时由 listEnabled 使用。 */
function buildSystemModelProviderDto(agentType: AgentType) {
  const emptyConfig: ProviderConfig = {
    baseUrl: "",
    apiKey: "",
    models: [],
    extraConfig: {},
  };
  return {
    modelProviderId: SYSTEM_MODEL_PROVIDER_ID,
    agentType,
    scope: MODEL_PROVIDER_SCOPE_SYSTEM as ModelProviderScope,
    userId: null,
    name: "系统环境",
    isEnabled: true,
    providerConfig: JSON.stringify({ ...emptyConfig, apiKey: "" }),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
