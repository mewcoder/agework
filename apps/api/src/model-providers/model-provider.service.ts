import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { spawnSync } from "node:child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AgentType } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import { PrismaService } from "../prisma/prisma.service";
import {
  getApiKey,
  normalizeBaseUrl,
  anthropicMessagesUrl,
  anthropicHeaders,
  openAIModelsUrl,
  openAIHeaders,
} from "./llm-client";

// system:<agent> 是系统环境默认模型服务的固定 ID，走 agent CLI 本身的配置文件。
const SYSTEM_PREFIX = "system:";
const ENVIRONMENT_MODEL_PROVIDER_NAME = "系统环境";
const MODEL_PROVIDER_SCOPE_ENVIRONMENT = "environment";
const MODEL_PROVIDER_SCOPE_GLOBAL = "global";
const ENVIRONMENT_AGENT_TYPES = ["claude", "codex"] as const;

type ModelProviderScope = "environment" | "global" | "user";
type EnvironmentStatus = {
  command: string;
  commandAvailable: boolean;
  configAvailable: boolean;
};
type ProviderConfigColumns = {
  baseUrl: string;
  apiKey: string;
  models: unknown;
  extraConfig: unknown;
};

function isEnvironmentModelProviderId(id: string) {
  return id.startsWith(SYSTEM_PREFIX);
}

function environmentModelProviderId(agentType: string) {
  return `${SYSTEM_PREFIX}${agentType}`;
}

function agentTypeFromEnvironmentModelProviderId(id: string): AgentType {
  const agentType = id.slice(SYSTEM_PREFIX.length);
  if (agentType !== "claude" && agentType !== "codex") {
    throw new BadRequestException(`模型服务不可用: ${id}`);
  }
  return agentType;
}

function normalizeModels(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  return models.filter((m): m is string => typeof m === "string");
}

function normalizeExtraConfig(extraConfig: unknown): Record<string, string> {
  if (typeof extraConfig !== "object" || extraConfig === null || Array.isArray(extraConfig)) {
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
function serializeProviderConfig(row: ProviderConfigColumns, desensitize: boolean): string {
  const config = toProviderConfig(row);
  return JSON.stringify(desensitize ? { ...config, apiKey: "" } : config);
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    timeout: 1500,
  });
  return !result.error && result.status === 0;
}

function claudeConfigDir(home: string): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
}

function hasClaudeAuthEnv(): boolean {
  return (
    !!process.env.ANTHROPIC_AUTH_TOKEN ||
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  );
}

function hasClaudeConfigFiles(home: string): boolean {
  const configDir = claudeConfigDir(home);
  return (
    existsSync(join(home, ".claude.json")) ||
    existsSync(join(configDir, ".credentials.json")) ||
    existsSync(join(configDir, "settings.json"))
  );
}

@Injectable()
export class ModelProviderService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await Promise.all(
      ENVIRONMENT_AGENT_TYPES.map((agentType) =>
        this.ensureEnvironmentModelProvider(agentType)
      )
    );
  }

  private async ensureEnvironmentModelProvider(agentType: string) {
    const id = environmentModelProviderId(agentType);
    const placeholder = {
      agentType,
      scope: MODEL_PROVIDER_SCOPE_ENVIRONMENT,
      userId: null,
      name: ENVIRONMENT_MODEL_PROVIDER_NAME,
      baseUrl: "",
      apiKey: "",
      models: [] as string[],
      extraConfig: {} as Record<string, string>,
    };
    const existing = await this.prisma.modelProvider.findUnique({
      where: { id },
    });
    if (existing) {
      const isPlaceholder =
        existing.agentType === agentType &&
        existing.scope === MODEL_PROVIDER_SCOPE_ENVIRONMENT &&
        existing.userId === null &&
        existing.name === ENVIRONMENT_MODEL_PROVIDER_NAME &&
        existing.baseUrl === "" &&
        existing.apiKey === "" &&
        normalizeModels(existing.models).length === 0 &&
        Object.keys(normalizeExtraConfig(existing.extraConfig)).length === 0;
      if (isPlaceholder) return existing;
      return this.prisma.modelProvider.update({
        where: { id },
        data: placeholder,
      });
    }

    return this.prisma.modelProvider.create({
      data: { id, ...placeholder, isEnabled: false },
    });
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
    const modelProviders = await this.prisma.modelProvider.findMany({
      where: {
        agentType: resolvedAgentType,
        ...(includeDisabled ? {} : { isEnabled: true }),
      },
      orderBy: { createdAt: "asc" },
    });
    const sorted = [...modelProviders].sort((a, b) => {
      const aEnvironment = isEnvironmentModelProviderId(a.id);
      const bEnvironment = isEnvironmentModelProviderId(b.id);
      if (aEnvironment !== bEnvironment) return aEnvironment ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    // desensitize: includeDisabled=true 代表走 admin 接口（listForAdmin），不脱敏；
    // includeDisabled=false 代表 listEnabled（非 admin），脱敏。
    const desensitize = !includeDisabled;
    return sorted.map((p) =>
      toModelProviderDto(
        {
          ...p,
          environmentStatus: isEnvironmentModelProviderId(p.id)
            ? this.getEnvironmentStatus(p.agentType)
            : undefined,
        },
        desensitize
      )
    );
  }

  private getEnvironmentStatus(agentType: string): EnvironmentStatus {
    const home = homedir();

    if (agentType === "claude") {
      return {
        command: "claude",
        commandAvailable: isCommandAvailable("claude"),
        configAvailable: hasClaudeAuthEnv() || hasClaudeConfigFiles(home),
      };
    }

    return {
      command: "codex",
      commandAvailable: isCommandAvailable("codex"),
      configAvailable:
        !!process.env.OPENAI_API_KEY ||
        !!process.env.CODEX_API_KEY ||
        existsSync(join(home, ".codex", "auth.json")) ||
        existsSync(join(home, ".codex", "config.toml")),
    };
  }

  async listEnabled(agentType: string) {
    const list = await this.list(agentType, false);
    return { list };
  }

  async listForAdmin(agentType: string) {
    const list = await this.list(agentType, true);
    return { list };
  }

  async create(agentType: string, name: string, providerConfig: ProviderConfig) {
    const resolvedAgentType = this.resolveAgentType(agentType);
    const providerName = this.normalizeName(name);
    this.validateBaseUrl(providerConfig.baseUrl);
    await this.assertNameAvailable(
      resolvedAgentType,
      MODEL_PROVIDER_SCOPE_GLOBAL,
      null,
      providerName
    );
    const modelProvider = await this.prisma.modelProvider.create({
      data: {
        agentType: resolvedAgentType,
        scope: MODEL_PROVIDER_SCOPE_GLOBAL,
        userId: null,
        name: providerName,
        isEnabled: true,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        models: providerConfig.models,
        extraConfig: providerConfig.extraConfig,
      },
    });
    return toModelProviderDto(modelProvider, false);
  }

  async update(modelProviderId: string, name: string, providerConfig: ProviderConfig) {
    if (isEnvironmentModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不可修改");
    const modelProvider = await this.prisma.modelProvider.findUnique({
      where: { id: modelProviderId },
    });
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    this.validateBaseUrl(providerConfig.baseUrl);
    const providerName = this.normalizeName(name);
    await this.assertNameAvailable(
      modelProvider.agentType,
      modelProvider.scope as ModelProviderScope,
      modelProvider.userId,
      providerName,
      modelProvider.id
    );
    const updated = await this.prisma.modelProvider.update({
      where: { id: modelProviderId },
      data: {
        name: providerName,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        models: providerConfig.models,
        extraConfig: providerConfig.extraConfig,
      },
    });
    return toModelProviderDto(updated, false);
  }

  async setEnabled(modelProviderId: string, isEnabled: boolean) {
    if (isEnvironmentModelProviderId(modelProviderId)) {
      const agentType = agentTypeFromEnvironmentModelProviderId(modelProviderId);
      await this.ensureEnvironmentModelProvider(agentType);
      const updated = await this.prisma.modelProvider.update({
        where: { id: modelProviderId },
        data: { isEnabled },
      });
      return toModelProviderDto(updated, false);
    }

    const modelProvider = await this.prisma.modelProvider.findUnique({
      where: { id: modelProviderId },
    });
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    const updated = await this.prisma.modelProvider.update({
      where: { id: modelProviderId },
      data: { isEnabled },
    });
    return toModelProviderDto(updated, false);
  }

  // 供 agent 模块解析运行所需的模型服务：环境配置返回占位 ProviderConfig，
  // 其余按 agentType 校验启用状态。未找到/不可用返回 null，由调用方决定如何报错。
  async resolveEnabledConfig(
    agentType: string,
    modelProviderId: string
  ): Promise<{
    providerConfig: ProviderConfig;
    providerSource: "environment" | "database";
  } | null> {
    if (isEnvironmentModelProviderId(modelProviderId)) {
      if (modelProviderId !== environmentModelProviderId(agentType)) return null;
      return {
        providerConfig: { baseUrl: "", apiKey: "", models: [], extraConfig: {} },
        providerSource: "environment",
      };
    }

    const modelProvider = await this.prisma.modelProvider.findFirst({
      where: { id: modelProviderId, agentType, isEnabled: true },
    });
    if (!modelProvider) return null;
    return {
      providerConfig: toProviderConfig(modelProvider),
      providerSource: "database",
    };
  }

  async delete(modelProviderId: string) {
    if (isEnvironmentModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不可删除");
    const modelProvider = await this.prisma.modelProvider.findUnique({
      where: { id: modelProviderId },
    });
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    if (modelProvider.isEnabled)
      throw new BadRequestException("启用中的模型服务不可删除，请先停用");
    await this.prisma.modelProvider.delete({ where: { id: modelProviderId } });
  }

  getSystemInfo(agent: AgentType) {
    const home = homedir();

    const envVar = (name: string) => {
      const val = process.env[name];
      return {
        name,
        isSet: !!val,
        preview: val ? val.slice(0, 8) + "..." : "",
      };
    };

    if (agent === "claude") {
      const configPath = join(home, ".claude.json");
      const configDir = claudeConfigDir(home);

      return {
        envVars: [
          envVar("ANTHROPIC_API_KEY"),
          envVar("ANTHROPIC_AUTH_TOKEN"),
          envVar("ANTHROPIC_BASE_URL"),
          envVar("ANTHROPIC_MODEL"),
          envVar("CLAUDE_CODE_OAUTH_TOKEN"),
          envVar("CLAUDE_CONFIG_DIR"),
          envVar("CLAUDE_SECURESTORAGE_CONFIG_DIR"),
        ],
        configFiles: [
          {
            path: configPath,
            exists: existsSync(configPath),
            description: "主配置文件",
          },
          {
            path: join(configDir, ".credentials.json"),
            exists: existsSync(join(configDir, ".credentials.json")),
            description: "账号登录认证文件",
          },
          {
            path: join(configDir, "settings.json"),
            exists: existsSync(join(configDir, "settings.json")),
            description: "设置文件",
          },
        ],
      };
    }

    // Codex
    const authPath = join(home, ".codex", "auth.json");
    const configToml = join(home, ".codex", "config.toml");

    return {
      envVars: [envVar("OPENAI_API_KEY"), envVar("CODEX_API_KEY")],
      configFiles: [
        {
          path: authPath,
          exists: existsSync(authPath),
          description: "认证文件",
        },
        {
          path: configToml,
          exists: existsSync(configToml),
          description: "主配置文件",
        },
      ],
    };
  }

  async test(
    modelProviderId: string,
    includeDisabled = false
  ): Promise<{ success: boolean; latency: number; error?: string }> {
    if (isEnvironmentModelProviderId(modelProviderId))
      throw new BadRequestException("系统环境不支持连通性测试");

    const modelProvider = await this.prisma.modelProvider.findUnique({
      where: { id: modelProviderId },
    });
    if (!modelProvider)
      throw new NotFoundException(`模型服务不存在: ${modelProviderId}`);
    if (!includeDisabled && !modelProvider.isEnabled)
      throw new BadRequestException(`模型服务不可用: ${modelProviderId}`);

    const providerConfig = toProviderConfig(modelProvider);
    const agentType = modelProvider.agentType as AgentType;
    const apiKey = getApiKey(providerConfig);
    const start = Date.now();

    try {
      let res: Response;
      const base = normalizeBaseUrl(providerConfig.baseUrl);
      if (!base) return { success: false, latency: 0, error: "未配置 baseUrl" };

      if (agentType === "claude") {
        const model = providerConfig.models[0];
        if (!model) return { success: false, latency: 0, error: "未配置 models" };
        res = await fetch(anthropicMessagesUrl(base), {
          method: "POST",
          headers: anthropicHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: AbortSignal.timeout(10000),
        });
      } else {
        res = await fetch(openAIModelsUrl(base), {
          headers: openAIHeaders(apiKey),
          signal: AbortSignal.timeout(10000),
        });
      }

      const latency = Date.now() - start;

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          success: false,
          latency,
          error: `HTTP ${res.status}: ${body.slice(0, 120)}`,
        };
      }

      return { success: true, latency };
    } catch (err: unknown) {
      return {
        success: false,
        latency: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private resolveAgentType(agentType: string): AgentType {
    if (agentType !== "claude" && agentType !== "codex") {
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
    const existing = await this.prisma.modelProvider.findFirst({
      where: {
        agentType,
        scope,
        userId,
        name,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
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
    environmentStatus?: EnvironmentStatus;
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
    ...(modelProvider.environmentStatus
      ? { environmentStatus: modelProvider.environmentStatus }
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
