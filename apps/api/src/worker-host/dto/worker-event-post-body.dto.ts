import {
  Allow,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import {
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
} from "@agework/shared/protocol/rpc";

/**
 * class field 声明（`useDefineForClassFields`）会让 DTO 实例上每个声明字段都
 * 变成"始终存在"的own property（值为 undefined），而 JSON 不会显式传 undefined——
 * 剥离掉这些幽灵 key，才能让下面复用的 `"x" in value` 判别联合类型守卫按真实
 * 传入的字段判断。
 */
function stripUndefinedKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== undefined) result[key] = val;
  }
  return result;
}

/** 复用 worker-event.parser.ts 内部依赖的同一批类型守卫，只做结构校验，不做业务转换。 */
function isValidWorkerEventPostBody(value: unknown): boolean {
  const item = stripUndefinedKeys(value);
  return (
    isWorkerEventRpcNotification(item) || isWorkerCommandResultRpcResponse(item)
  );
}

@ValidatorConstraint({ name: "workerEventPostBody", async: false })
class WorkerEventPostBodyConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return isValidWorkerEventPostBody(args.object);
  }

  defaultMessage(): string {
    return "Invalid worker event body";
  }
}

/**
 * POST /worker/runs/:runId/events request body ── worker 上报的 JSON-RPC 上行
 * 事件，是 notification / command-result 两种形状的判别联合。字段按 @Allow()
 * 直通（判别联合没有统一 shape，无法逐字段强类型校验），结构校验复用
 * worker-event.parser.ts 内部同一批类型守卫（isWorkerEventRpcNotification /
 * isWorkerCommandResultRpcResponse）；实际的 runId 归属校验与转换仍在
 * WorkerEndpointHandler.postEvent() 里完成。
 */
export class WorkerEventPostBodyDto {
  @Allow()
  @Validate(WorkerEventPostBodyConstraint)
  jsonrpc?: unknown;

  @Allow()
  id?: unknown;

  @Allow()
  method?: unknown;

  @Allow()
  params?: unknown;

  @Allow()
  result?: unknown;

  @Allow()
  error?: unknown;

  @Allow()
  meta?: unknown;
}
