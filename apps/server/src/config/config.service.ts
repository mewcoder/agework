import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { mkdirSync } from "fs";
import { join } from "path";
import { isRuntimeType, type RuntimeType } from "@agework/runtime-sdk";
import type { WorkerScope } from "@agework/shared/protocol";
import { SystemSettingRepository } from "./system-setting.repository";
import { resolveApiBasePath } from "../common/api-path";
import {
  AGEWORK_HOST_CLI_DIR,
  AGEWORK_HOST_RUNTIME_LOG_DIR,
  AGEWORK_HOST_WORKSPACES_ROOT,
  DEFAULT_RUNTIME_IMAGE,
  DEFAULT_API_BODY_LIMIT,
  DEFAULT_APP_NAME,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
  DEFAULT_HEARTBEAT_CHECK_INTERVAL_SECONDS,
  DEV_JWT_SECRET,
  DEFAULT_ALLOWED_RUNTIME_TYPES,
  DEFAULT_ALLOWED_SCOPES,
  DEFAULT_PORT,
  DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB,
  DEFAULT_BUILTIN_WORKER_HTTP_PORT,
} from "./registry/defaults";
import { EnvKey } from "./registry/env-key";
import {
  coerceSettingValue,
  getSettingDefinition,
  SETTINGS_REGISTRY,
  SettingKey,
} from "./registry/settings-registry";

export { DEV_JWT_SECRET } from "./registry/defaults";

export type SettingSource = "db" | "env" | "default";

export interface SettingListItem {
  key: string;
  type: "string" | "number" | "boolean";
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
  if (process.env[EnvKey.DEV_AUTH_DISABLED] === "true") return DEV_JWT_SECRET;
  throw new Error(
    "未配置 AGEWORK_PRIVATE_JWT_SECRET：登录验证已启用时必须设置 AGEWORK_PRIVATE_JWT_SECRET（或设置 AGEWORK_DEV_AUTH_DISABLED=true 仅用于开发）"
  );
}

const SCOPES = ["user", "workspace"] as const satisfies readonly WorkerScope[];

function isWorkerScope(value: string): value is WorkerScope {
  return (SCOPES as readonly string[]).includes(value);
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

  constructor(private readonly settings: SystemSettingRepository) {
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
    const rows = await this.settings.loadAll();
    this.settingsCache = new Map(rows.map((row) => [row.key, row.value]));
  }

  /**
   * 为 SETTINGS_REGISTRY 中尚未写入数据库的配置项写入默认值，已有记录不覆盖。
   * env 覆盖值优先于代码级默认值。systemSetting 数据生命周期归本领域所有。
   */
  async seedDefaults(): Promise<void> {
    for (const definition of SETTINGS_REGISTRY) {
      const existing = await this.settings.findKey(definition.key);
      if (existing) continue;
      await this.settings.seedDefault(
        definition.key,
        process.env[definition.key] ?? definition.defaultValue
      );
    }
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

  /**
   * 开发态是否关闭登录验证：仅 development（或未设置 NODE_ENV）且
   * AGEWORK_DEV_AUTH_DISABLED=true 时启用，防止 staging/test 误绕过认证。
   */
  isDevAuthDisabled(): boolean {
    const nodeEnv = process.env.NODE_ENV;
    const isDev = !nodeEnv || nodeEnv === "development";
    return isDev && this.getEnv(EnvKey.DEV_AUTH_DISABLED) === "true";
  }

  /**
   * 生产环境（NODE_ENV=production）首次初始化必须出示 setup key，
   * 防止公网部署时第一个访问者抢注超级管理员。非生产环境放行以便本地调试。
   */
  requiresAdminInitKey(): boolean {
    return process.env.NODE_ENV === "production";
  }

  /** 是否为生产环境（NODE_ENV=production）。 */
  isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  }

  /** 首次初始化的引导密钥，init 自动生成并写入 .env。 */
  getAdminInitKey(): string | undefined {
    return this.getEnv(EnvKey.PRIVATE_ADMIN_INIT_KEY) || undefined;
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
      ? raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [...DEFAULT_ALLOWED_RUNTIME_TYPES];

    if (values.length === 0 || values.some((value) => !isRuntimeType(value))) {
      throw new Error(
        `AGEWORK_RUNTIME_ALLOWED_TYPES expects comma-separated runtime identifiers, got: ${raw ?? values.join(",")}`
      );
    }

    return Array.from(new Set(values)) as RuntimeType[];
  }

  /** builtin Host 显式允许加载的 runtime 插件包；不做隐式发现。 */
  getRuntimePluginPackages(): string[] {
    const raw = this.getEnv(EnvKey.RUNTIME_PLUGINS);
    if (!raw) return [];
    const packages = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (packages.some((value) => /\s/.test(value))) {
      throw new Error(
        `AGEWORK_RUNTIME_PLUGINS expects comma-separated package names, got: ${raw}`
      );
    }
    return Array.from(new Set(packages));
  }

  /** builtin Host 显式允许 Worker 加载的 Agent Adapter 插件包。 */
  getAgentPluginPackages(): string[] {
    const raw = this.getEnv(EnvKey.AGENT_PLUGINS);
    if (!raw) return [];
    const packages = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (packages.some((value) => /\s/.test(value))) {
      throw new Error(
        `AGEWORK_AGENT_PLUGINS expects comma-separated package names, got: ${raw}`
      );
    }
    return Array.from(new Set(packages));
  }

  getDefaultRuntimeType(): RuntimeType {
    return this.getAllowedRuntimeTypes()[0];
  }

  isRuntimeTypeAllowed(runtimeType: string): runtimeType is RuntimeType {
    return (
      isRuntimeType(runtimeType) &&
      this.getAllowedRuntimeTypes().includes(runtimeType)
    );
  }

  getAllowedScopes(): WorkerScope[] {
    const raw = this.getEnv(EnvKey.RUNTIME_ALLOWED_SCOPES);
    const values = raw
      ? raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [...DEFAULT_ALLOWED_SCOPES];

    if (values.length === 0 || values.some((value) => !isWorkerScope(value))) {
      throw new Error(
        `AGEWORK_RUNTIME_ALLOWED_SCOPES expects comma-separated values from "user", "workspace", got: ${raw ?? values.join(",")}`
      );
    }

    return Array.from(new Set(values)) as WorkerScope[];
  }

  getDefaultWorkerScope(): WorkerScope {
    return this.getAllowedScopes()[0];
  }

  isWorkerScopeAllowed(scope: string): scope is WorkerScope {
    return isWorkerScope(scope) && this.getAllowedScopes().includes(scope);
  }

  getRuntimeLogDir(): string {
    mkdirSync(AGEWORK_HOST_RUNTIME_LOG_DIR, { recursive: true });
    return AGEWORK_HOST_RUNTIME_LOG_DIR;
  }

  /** builtin Host 上 agent CLI 一键安装的根目录。 */
  getHostCliDir(): string {
    return AGEWORK_HOST_CLI_DIR;
  }

  /** builtin Host 的非 native provider 起 worker 运行实例用的默认镜像。 */
  getWorkerImage(): string {
    return DEFAULT_RUNTIME_IMAGE;
  }

  /** API base path(context + /api/v1)。 */
  getApiBasePath(): string {
    return resolveApiBasePath(getApiContext());
  }

  /** agework-runtime 产物入口的显式覆盖(部署/排障用),未配置返回 undefined。 */
  getRuntimeLocalEntryOverride(): string | undefined {
    return this.getEnv(EnvKey.RUNTIME_LOCAL_ENTRY)?.trim() || undefined;
  }

  /**
   * agent event trace 开关与单文件上限：仅控制 raw/agui 大 payload 是否落 JSONL 文件，
   * 不影响 RunEvent 索引记录。默认开启（排查问题需要事后可查），单文件大小由
   * maxFileMb 兜底；显式设为 0/false/no/off 才关闭。
   */
  getAgentEventTraceConfig(): { enabled: boolean; maxFileMb: number } {
    const raw = this.getEnv(EnvKey.AGENT_EVENT_TRACE_ENABLED)?.toLowerCase();
    const enabled = raw ? !["0", "false", "no", "off"].includes(raw) : true;
    const parsed = Number(this.getEnv(EnvKey.AGENT_EVENT_TRACE_MAX_FILE_MB));
    const maxFileMb =
      Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB;
    return { enabled, maxFileMb };
  }

  /** Builtin Host 的 worker HTTP 服务器端口（Phase 3：worker 数据面不再连 server 旧端点）。 */
  getBuiltinWorkerHttpPort(): number {
    const raw = this.getEnv(EnvKey.BUILTIN_WORKER_HTTP_PORT);
    const port = Number(raw);
    return Number.isFinite(port) && port > 0
      ? port
      : DEFAULT_BUILTIN_WORKER_HTTP_PORT;
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

  getLaunchTimeoutSeconds(): number {
    return (
      this.getSettingNumber(SettingKey.RUNTIME_LAUNCH_TIMEOUT_SECONDS) ??
      DEFAULT_LAUNCH_TIMEOUT_SECONDS
    );
  }

  getHeartbeatTimeoutSeconds(): number {
    return (
      this.getSettingNumber(SettingKey.RUNTIME_HEARTBEAT_TIMEOUT_SECONDS) ??
      DEFAULT_HEARTBEAT_TIMEOUT_SECONDS
    );
  }

  getHeartbeatCheckIntervalSeconds(): number {
    return (
      this.getSettingNumber(
        SettingKey.RUNTIME_HEARTBEAT_CHECK_INTERVAL_SECONDS
      ) ?? DEFAULT_HEARTBEAT_CHECK_INTERVAL_SECONDS
    );
  }

  /** 是否允许用户选择"系统环境"模型配置（admin 全局开关，见 runtime ADR-0003）。 */
  isSystemEnvEnabled(): boolean {
    const raw = this.getSetting(SettingKey.SYSTEM_ENV_ENABLED);
    if (raw === undefined) return true;
    return raw === "true";
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
    await this.settings.upsert(key, value, userId);
    this.settingsCache.set(key, value);
  }

  async resetSetting(key: string): Promise<void> {
    const definition = getSettingDefinition(key);
    if (!definition) {
      throw new BadRequestException(`未知的系统设置项: ${key}`);
    }
    await this.settings.deleteByKey(key);
    this.settingsCache.delete(key);
  }
}
