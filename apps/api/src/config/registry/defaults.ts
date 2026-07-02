import { homedir } from "os";
import { join } from "path";
import { EnvKey } from "./env-key";

/**
 * AgeWork 代码级默认配置。
 *
 * 这里放的是 fork/私有部署想改变默认行为时可以直接改代码的固定值。
 * 不属于部署差异的值不要再额外暴露 ENV。
 */

export const DEFAULT_APP_NAME = "AgeWork";
export const DEFAULT_PORT = 3000;
export const DEFAULT_API_BODY_LIMIT = "50mb";
export const DEV_JWT_SECRET = "agework-dev-secret";

export const DEFAULT_ALLOWED_RUNTIME_TYPES = ["local"] as const;
export const DEFAULT_ALLOWED_ISOLATION_SCOPES = ["user"] as const;
export const DEFAULT_SANDBOX_ENGINE = "docker";
export const DEFAULT_WORKER_IMAGE = "agework/worker:latest";
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800;
export const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;
export const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 120;
export const DEFAULT_AGENT_EVENT_TRACE_MAX_FILE_MB = 50;

export const DEFAULT_OPENSANDBOX_DOMAIN = "localhost:8080";
export const DEFAULT_OPENSANDBOX_PROTOCOL = "http";
export const DEFAULT_OPENSANDBOX_IMAGE = DEFAULT_WORKER_IMAGE;
export const DEFAULT_OPENSANDBOX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_OPENSANDBOX_USE_SERVER_PROXY = false;

export const AGEWORK_HOST_DATA_DIR =
  process.env[EnvKey.DATA_DIR]?.trim() || join(homedir(), ".agework");
export const AGEWORK_HOST_WORKSPACES_ROOT = join(
  AGEWORK_HOST_DATA_DIR,
  "workspaces"
);
export const AGEWORK_HOST_RUNTIME_LOG_DIR = join(
  AGEWORK_HOST_DATA_DIR,
  "logs",
  "runtime"
);

export const CONTAINER_HOME = "/home/agework";
export const CONTAINER_WORKSPACES_ROOT = `${CONTAINER_HOME}/workspaces`;
export const CONTAINER_RUNTIME_LOG_DIR = `${CONTAINER_HOME}/.agework/logs/runtime`;
