import { join, posix } from "node:path";
import type {
  AgentEventTraceConfig,
  RunConfig,
  RunPlacement,
  RuntimeSpec,
  SubmitRunInput,
} from "@agework/shared/protocol";
import { parseOwnerKey } from "@agework/shared/protocol";
import { isRuntimeType, resolveRuntimeSpec } from "@agework/providers";
import type { RuntimeHostConfig } from "./runtime-host.js";

/**
 * placement → 执行机细节派生(纯计算域,从 RuntimeHost 拆出):
 * runtime spec 解析、RunConfig / 日志路径 / trace 配置 / worker env 构造。
 * 不持有状态,全部输入显式来自 RuntimeHostConfig 与 run 提交参数。
 */

export function resolveSpec(
  config: RuntimeHostConfig,
  placement: RunPlacement
): RuntimeSpec {
  const runtimeType = placement.runtimeType;
  if (!isRuntimeType(runtimeType)) {
    throw new Error(`unsupported runtimeType: ${runtimeType}`);
  }
  const base = {
    userId: placement.userId,
    workspaceId: placement.workspaceId,
    workspaceRootPath: placement.workspacePath,
    userWorkspaceRootPath: config.getUserWorkspace(placement.username),
    runtimeLogHostPath: config.runtimeLogDir,
  };
  if (runtimeType === "native") {
    return resolveRuntimeSpec({ ...base, runtimeType: "native" });
  }
  return resolveRuntimeSpec({
    ...base,
    runtimeType,
    scope: parseOwnerKey(placement.owner).scope,
  });
}

export async function makeRunConfig(
  config: RuntimeHostConfig,
  input: SubmitRunInput,
  placement: RuntimeSpec
): Promise<RunConfig> {
  const { runId, conversationId, agentProviderConfig } = input;
  const logPaths = makeLogPaths(config, placement, conversationId);

  // native 的 CLI 路径由 Host 侧合成(override > detected);container 不走此链路
  // (镜像固定路径,经 env 注入)。
  let cliPaths: {
    claude: string | null;
    codex: string | null;
    opencode: string | null;
  } | null = null;
  if (placement.runtimeType === "native" && config.resolveCliPaths) {
    cliPaths = await config.resolveCliPaths();
  }

  return {
    runId,
    conversationId,
    workspaceId: input.placement.workspaceId,
    runtimePath: placement.runtimePath,
    env: {},
    input: input.input,
    agentProviderConfig,
    agentEventTrace: buildTraceConfig(
      config,
      runId,
      conversationId,
      input.placement.workspaceId,
      agentProviderConfig.agentType,
      logPaths
    ),
    workerLogFilePath: logPaths.workerRuntimeFilePath,
    ...(cliPaths?.claude ? { claudeExecutablePath: cliPaths.claude } : {}),
    ...(cliPaths?.codex ? { codexExecutablePath: cliPaths.codex } : {}),
    ...(cliPaths?.opencode
      ? { opencodeExecutablePath: cliPaths.opencode }
      : {}),
  };
}

function makeLogPaths(
  config: RuntimeHostConfig,
  placement: RuntimeSpec,
  conversationId: string
) {
  const logDir = config.runtimeLogDir;
  const fileName = conversationId.replace(/[^a-zA-Z0-9-]/g, "_");
  const runtimeLogDir = placement.runtimeLogDir;
  return {
    logDir,
    rawFilePath: join(logDir, `${fileName}.raw.jsonl`),
    rawRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.raw.jsonl`),
    aguiFilePath: join(logDir, `${fileName}.agui.jsonl`),
    aguiRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.agui.jsonl`),
    workerRuntimeFilePath: posix.join(runtimeLogDir, `${fileName}.worker.log`),
  };
}

function buildTraceConfig(
  config: RuntimeHostConfig,
  runId: string,
  conversationId: string,
  workspaceId: string,
  agentType: string,
  paths: ReturnType<typeof makeLogPaths>
): AgentEventTraceConfig {
  const enabled = config.agentEventTrace.enabled;
  return {
    enabled,
    logDir: enabled ? paths.logDir : undefined,
    rawFilePath: enabled ? paths.rawFilePath : undefined,
    rawRuntimeFilePath: enabled ? paths.rawRuntimeFilePath : undefined,
    aguiFilePath: enabled ? paths.aguiFilePath : undefined,
    aguiRuntimeFilePath: enabled ? paths.aguiRuntimeFilePath : undefined,
    maxFileMb: config.agentEventTrace.maxFileMb,
    runId,
    conversationId,
    workspaceId,
    agentType,
  };
}

export function buildWorkerEnv(
  config: RuntimeHostConfig,
  placement: RunPlacement,
  startToken: string,
  workerId: string,
  runtimeType: string,
  runtimeTarget: RuntimeSpec,
  runConfig: RunConfig
): Record<string, string> {
  const env: Record<string, string> = {
    AGEWORK_WORKER_ROLE: "worker",
    AGEWORK_WORKER_OWNER_ID: parseOwnerKey(placement.owner).id,
    AGEWORK_WORKER_ID: workerId,
    AGEWORK_WORKER_START_TOKEN: startToken,
    AGEWORK_WORKER_RUNTIME_TYPE: runtimeType,
    AGEWORK_WORKER_SCOPE: parseOwnerKey(placement.owner).scope,
    AGEWORK_WORKER_WORKSPACE_PATH: runtimeTarget.runtimePath,
  };
  if (runConfig.workerLogFilePath) {
    env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
  }
  // provider（native / sandbox）会用 RuntimeConfig.workerApiBaseUrl 覆盖此值，
  // 因此该地址必须指向本 Host 的 worker HTTP 端点。
  if (config.workerApiBaseUrl) {
    env.AGEWORK_WORKER_API_BASE = config.workerApiBaseUrl;
  }
  return env;
}
