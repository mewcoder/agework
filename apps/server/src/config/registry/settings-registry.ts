import { BadRequestException } from "@nestjs/common";
import {
  DEFAULT_APP_NAME,
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
  DEFAULT_HEARTBEAT_CHECK_INTERVAL_SECONDS,
} from "./defaults";

/**
 * 系统设置白名单：仅这里声明的 key 可被管理员通过后台接口读写。
 * 与 EnvKey 是两个独立的命名空间——多数 key 同时也是 env 回退变量名，
 * 但未来允许新增纯 DB 设置项（无对应 env 变量）。
 */
export const SettingKey = {
  APP_NAME: "AGEWORK_APP_NAME",
  RUNTIME_IDLE_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS",
  RUNTIME_RUN_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS",
  RUNTIME_LAUNCH_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_LAUNCH_TIMEOUT_SECONDS",
  RUNTIME_HEARTBEAT_TIMEOUT_SECONDS:
    "AGEWORK_RUNTIME_HEARTBEAT_TIMEOUT_SECONDS",
  RUNTIME_HEARTBEAT_CHECK_INTERVAL_SECONDS:
    "AGEWORK_RUNTIME_HEARTBEAT_CHECK_INTERVAL_SECONDS",
  SYSTEM_ENV_ENABLED: "AGEWORK_SYSTEM_ENV_ENABLED",
} as const;

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

export type SettingType = "string" | "number" | "boolean";

export interface SettingDefinition {
  key: SettingKey;
  type: SettingType;
  label: string;
  description: string;
  /** 代码级默认值，DB 和 env 均未设置时展示给管理员。 */
  defaultValue: string;
}

/**
 * 其余配置（运维/部署级、启动必需）继续走 process.env，不进入此表。
 */
export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    key: SettingKey.APP_NAME,
    type: "string",
    label: "平台名称",
    description: "显示在前端界面上的应用名称",
    defaultValue: DEFAULT_APP_NAME,
  },
  {
    key: SettingKey.RUNTIME_IDLE_TIMEOUT_SECONDS,
    type: "number",
    label: "Runtime 空闲超时（秒）",
    description: "Runtime 资源空闲超过该时长后会被回收",
    defaultValue: String(DEFAULT_IDLE_TIMEOUT_SECONDS),
  },
  {
    key: SettingKey.RUNTIME_RUN_TIMEOUT_SECONDS,
    type: "number",
    label: "Run 执行超时（秒）",
    description: "Run 执行超过该时长未进入终态后会标记为错误",
    defaultValue: String(DEFAULT_RUN_TIMEOUT_SECONDS),
  },
  {
    key: SettingKey.RUNTIME_LAUNCH_TIMEOUT_SECONDS,
    type: "number",
    label: "Runtime 启动超时(秒)",
    description: "新建 runtime 实例(容器/进程)超过该时长未就绪则判定为启动失败",
    defaultValue: String(DEFAULT_LAUNCH_TIMEOUT_SECONDS),
  },
  {
    key: SettingKey.RUNTIME_HEARTBEAT_TIMEOUT_SECONDS,
    type: "number",
    label: "Worker 心跳超时(秒)",
    description:
      "worker 长轮询超过该时长没有被看见则判定为 unhealthy,触发 fence",
    defaultValue: String(DEFAULT_HEARTBEAT_TIMEOUT_SECONDS),
  },
  {
    key: SettingKey.RUNTIME_HEARTBEAT_CHECK_INTERVAL_SECONDS,
    type: "number",
    label: "Worker 心跳检查间隔(秒)",
    description: "watchdog 扫描一次所有 owner 心跳的间隔",
    defaultValue: String(DEFAULT_HEARTBEAT_CHECK_INTERVAL_SECONDS),
  },
  {
    key: SettingKey.SYSTEM_ENV_ENABLED,
    type: "boolean",
    label: "允许选择系统环境",
    description:
      "开启后用户可选择「系统环境」模型配置（使用本机 agent CLI 自带认证）。实际是否可用还取决于工作空间绑定的 Runtime 是否检测到对应 CLI + 认证。",
    defaultValue: "true",
  },
];

export function getSettingDefinition(
  key: string
): SettingDefinition | undefined {
  return SETTINGS_REGISTRY.find((item) => item.key === key);
}

/** 按 Registry 中声明的 type 校验并规范化原始值，非法值抛出 BadRequestException。 */
export function coerceSettingValue(
  definition: SettingDefinition,
  rawValue: string
): string {
  if (definition.type === "number") {
    const num = Number(rawValue);
    if (!Number.isFinite(num)) {
      throw new BadRequestException(
        `${definition.key} 必须是数字，收到: ${rawValue}`
      );
    }
    return String(num);
  }
  if (definition.type === "boolean") {
    const lower = rawValue.toLowerCase().trim();
    if (lower === "true" || lower === "1") return "true";
    if (lower === "false" || lower === "0") return "false";
    throw new BadRequestException(
      `${definition.key} 必须是布尔值，收到: ${rawValue}`
    );
  }
  return rawValue;
}
