import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { mkdirSync } from "fs";
import { join } from "path";
import { PrismaService } from "../prisma/prisma.service";
import {
  AGEWORK_HOST_RUNTIME_LOG_DIR,
  AGEWORK_HOST_WORKSPACES_ROOT,
  DEFAULT_API_BODY_LIMIT,
  DEFAULT_APP_NAME,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  DEV_JWT_SECRET,
  DEFAULT_OPENSANDBOX_DOMAIN,
  DEFAULT_OPENSANDBOX_IMAGE,
  DEFAULT_OPENSANDBOX_PROTOCOL,
  DEFAULT_OPENSANDBOX_TIMEOUT_SECONDS,
  DEFAULT_OPENSANDBOX_USE_SERVER_PROXY,
  DEFAULT_ALLOWED_RUNTIME_TYPES,
  DEFAULT_ALLOWED_ISOLATION_SCOPES,
  DEFAULT_PORT,
  DEFAULT_SANDBOX_ENGINE,
} from "./defaults";
import { EnvKey } from "./env-key";
import {
  coerceSettingValue,
  getSettingDefinition,
  SETTINGS_REGISTRY,
  SettingKey,
} from "./settings-registry";

export { DEV_JWT_SECRET } from "./defaults";

export type SettingSource = "db" | "env" | "default";

export interface SettingListItem {
  key: string;
  type: "string" | "number";
  label: string;
  description: string;
  value: string | undefined;
  source: SettingSource;
}

/** HTTP 监听端口，启动路径在 DI 容器就绪前读取，因此提供独立函数。 */
export function getPort(): number {
  const port = Number(process.env[EnvKey.PORT]);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

/** API 请求体大小限制，启动路径在 DI 容器就绪前读取，因此提供独立函数。 */
export function getApiBodyLimit(): string {
  return process.env[EnvKey.BODY_LIMIT] || DEFAULT_API_BODY_LIMIT;
}

/** API context，启动路径在 DI 容器就绪前读取，因此提供独立函数。 */
export function getApiContext(): string | undefined {
  return process.env[EnvKey.CONTEXT];
}

/** 是否托管前端静态资源，模块装饰器在 DI 容器就绪前求值，因此提供独立函数。 */
export function isServeFrontendEnabled(): boolean {
  return process.env[EnvKey.SERVE_FRONTEND] === "true";
}

/**
 * JWT 签名 secret：单一来源，避免多个模块各自硬编码 fallback 字符串。
 * 当登录验证未关闭（AGEWORK_DEV_AUTH_DISABLED !== "true"）且未配置 AGEWORK_PRIVATE_JWT_SECRET 时，
 * 直接 fail fast，避免生产环境静默使用内置开发密钥。
 */
export function getJwtSecret(): string {
  const secret = process.env[EnvKey.PRIVATE_JWT_SECRET];
  if (
    process.env.NODE_ENV === "production" &&
    (!secret || secret === DEV_JWT_SECRET)
  ) {
    throw new Error("生产环境必须配置安全的 AGEWORK_PRIVATE_JWT_SECRET");
  }
  if (secret) return secret;
  if (process.env[EnvKey.DEV_AUTH_DISABLED] === "true")
    return DEV_JWT_SECRET;
  throw new Error(
    "未配置 AGEWORK_PRIVATE_JWT_SECRET：登录验证已启用时必须设置 AGEWORK_PRIVATE_JWT_SECRET（或设置 AGEWORK_DEV_AUTH_DISABLED=true 仅用于开发）"
  );
}

export type IsolationScope = "user" | "workspace";
export type RuntimeType = "local" | "sandbox";
export type SandboxEngineType = "docker" | "opensandbox";

const RUNTIME_TYPES = ["local", "sandbox"] as const satisfies readonly RuntimeType[];
const ISOLATION_SCOPES = ["user", "workspace"] as const satisfies readonly IsolationScope[];

function isRuntimeType(value: string): value is RuntimeType {
  return (RUNTIME_TYPES as readonly string[]).includes(value);
}

function isIsolationScope(value: string): value is IsolationScope {
  return (ISOLATION_SCOPES as readonly string[]).includes(value);
}

/**
 * 应用配置门面：env 取值 + 系统设置（DB > env > 默认，admin 写入即时热生效）。
 * 仅 settings-registry 中声明的 key 可由管理员通过后台接口读写。
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  private readonly logger = new Logger(ConfigService.name);
  private readonly workspace: string;
  private settingsCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {
    try {
      mkdirSync(AGEWORK_HOST_WORKSPACES_ROOT, { recursive: true });
      this.workspace = AGEWORK_HOST_WORKSPACES_ROOT;
    } catch {
      throw new Error(
        `Failed to initialize workspace root: ${AGEWORK_HOST_WORKSPACES_ROOT}`
      );
    }
    this.logger.log(`Workspace resolved to: ${this.workspace}`);
  }

  async onModuleInit() {
    const rows = await this.prisma.systemSetting.findMany();
    this.settingsCache = new Map(rows.map((row) => [row.key, row.value]));
  }

  /** 集中读取 process.env，统一入口避免裸字符串散落各 getter。 */
  private getEnv(key: EnvKey): string | undefined {
    return process.env[key];
  }

  /** 系统设置：DB 覆盖值 > env > undefined（调用方自行决定默认值）。 */
  private getSetting(key: SettingKey): string | undefined {
    return this.settingsCache.get(key) ?? process.env[key] ?? undefined;
  }

  private getSettingNumber(key: SettingKey): number | undefined {
    const raw = this.getSetting(key);
    if (raw === undefined) return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  }

  getWorkspace(): string {
    return this.workspace;
  }

  getAppName(): string {
    return this.getSetting(SettingKey.APP_NAME) || DEFAULT_APP_NAME;
  }

  getUserWorkspace(username: string): string {
    const dir = join(this.workspace, username);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getPort(): number {
    return getPort();
  }

  getApiBodyLimit(): string {
    return getApiBodyLimit();
  }

  getAllowedRuntimeTypes(): RuntimeType[] {
    const raw = this.getEnv(EnvKey.RUNTIME_ALLOWED_TYPES);
    const values = raw
      ? raw.split(",").map((value) => value.trim()).filter(Boolean)
      : [...DEFAULT_ALLOWED_RUNTIME_TYPES];

    if (values.length === 0 || values.some((value) => !isRuntimeType(value))) {
      throw new Error(
        `AGEWORK_RUNTIME_ALLOWED_TYPES expects comma-separated values from "local", "sandbox", got: ${raw ?? values.join(",")}`
      );
    }

    return Array.from(new Set(values)) as RuntimeType[];
  }

  getDefaultRuntimeType(): RuntimeType {
    return this.getAllowedRuntimeTypes()[0];
  }

  isRuntimeTypeAllowed(runtimeType: string): runtimeType is RuntimeType {
    return isRuntimeType(runtimeType) && this.getAllowedRuntimeTypes().includes(runtimeType);
  }

  getAllowedIsolationScopes(): IsolationScope[] {
    const raw = this.getEnv(EnvKey.RUNTIME_ALLOWED_ISOLATION_SCOPES);
    const values = raw
      ? raw.split(",").map((value) => value.trim()).filter(Boolean)
      : [...DEFAULT_ALLOWED_ISOLATION_SCOPES];

    if (
      values.length === 0 ||
      values.some((value) => !isIsolationScope(value))
    ) {
      throw new Error(
        `AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES expects comma-separated values from "user", "workspace", got: ${raw ?? values.join(",")}`
      );
    }

    return Array.from(new Set(values)) as IsolationScope[];
  }

  getDefaultIsolationScope(): IsolationScope {
    return this.getAllowedIsolationScopes()[0];
  }

  isIsolationScopeAllowed(
    isolationScope: string
  ): isolationScope is IsolationScope {
    return (
      isIsolationScope(isolationScope) &&
      this.getAllowedIsolationScopes().includes(isolationScope)
    );
  }

  /** 新建 sandbox workspace 时的默认引擎，可选 `docker`、`opensandbox`。 */
  getSandboxEngine(): SandboxEngineType {
    const explicit = this.getEnv(EnvKey.SANDBOX_ENGINE);
    if (explicit === "docker" || explicit === "opensandbox") return explicit;
    return DEFAULT_SANDBOX_ENGINE;
  }

  getRuntimeLogDir(): string {
    mkdirSync(AGEWORK_HOST_RUNTIME_LOG_DIR, { recursive: true });
    return AGEWORK_HOST_RUNTIME_LOG_DIR;
  }

  getIdleTimeoutSeconds(): number {
    return (
      this.getSettingNumber(SettingKey.RUNTIME_IDLE_TIMEOUT_SECONDS) ??
      DEFAULT_IDLE_TIMEOUT_SECONDS
    );
  }

  getRunTimeoutSeconds(): number {
    return (
      this.getSettingNumber(SettingKey.RUNTIME_RUN_TIMEOUT_SECONDS) ??
      DEFAULT_RUN_TIMEOUT_SECONDS
    );
  }

  getOpenSandboxConfig(): {
    domain: string;
    protocol: "http" | "https";
    apiKey?: string;
    image: string;
    timeoutSeconds: number;
    useServerProxy: boolean;
  } {
    const useServerProxy = this.getEnv(
      EnvKey.SANDBOX_OPENSANDBOX_USE_SERVER_PROXY
    );
    return {
      domain:
        this.getEnv(EnvKey.SANDBOX_OPENSANDBOX_DOMAIN) ||
        DEFAULT_OPENSANDBOX_DOMAIN,
      protocol:
        this.getEnv(EnvKey.SANDBOX_OPENSANDBOX_PROTOCOL) === "https"
          ? "https"
          : DEFAULT_OPENSANDBOX_PROTOCOL,
      apiKey: this.getEnv(EnvKey.PRIVATE_OPENSANDBOX_API_KEY) || undefined,
      image:
        this.getEnv(EnvKey.SANDBOX_OPENSANDBOX_IMAGE) ||
        DEFAULT_OPENSANDBOX_IMAGE,
      timeoutSeconds: parseInt(
        this.getEnv(EnvKey.SANDBOX_OPENSANDBOX_TIMEOUT_SECONDS) ||
          String(DEFAULT_OPENSANDBOX_TIMEOUT_SECONDS),
        10
      ),
      useServerProxy:
        useServerProxy === undefined
          ? DEFAULT_OPENSANDBOX_USE_SERVER_PROXY
          : useServerProxy === "true",
    };
  }

  listSettings(): SettingListItem[] {
    return SETTINGS_REGISTRY.map((definition) => {
      const dbValue = this.settingsCache.get(definition.key);
      if (dbValue !== undefined) {
        return {
          key: definition.key,
          type: definition.type,
          label: definition.label,
          description: definition.description,
          value: dbValue,
          source: "db" as const,
        };
      }
      const envValue = process.env[definition.key];
      return {
        key: definition.key,
        type: definition.type,
        label: definition.label,
        description: definition.description,
        value: envValue ?? definition.defaultValue,
        source:
          envValue !== undefined ? ("env" as const) : ("default" as const),
      };
    });
  }

  async setSetting(
    key: string,
    rawValue: string,
    userId: string
  ): Promise<void> {
    const definition = getSettingDefinition(key);
    if (!definition) {
      throw new BadRequestException(`未知的系统设置项: ${key}`);
    }
    const value = coerceSettingValue(definition, rawValue);
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, updatedBy: userId },
      update: { value, updatedBy: userId },
    });
    this.settingsCache.set(key, value);
  }

  async resetSetting(key: string): Promise<void> {
    const definition = getSettingDefinition(key);
    if (!definition) {
      throw new BadRequestException(`未知的系统设置项: ${key}`);
    }
    await this.prisma.systemSetting.deleteMany({ where: { key } });
    this.settingsCache.delete(key);
  }
}
