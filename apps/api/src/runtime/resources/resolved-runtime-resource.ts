import type {
  RuntimePlacement,
  ResolvedRuntimeResource,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";

/** 类型守卫：narrow 出 sandbox 分支（placement.sandbox 必填）。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}

function requirePlacementString(
  placement: RuntimePlacement,
  key: "runtimeType" | "userId" | "workspaceId"
): string {
  const value = placement[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Runtime placement ${key} is required`);
  }
  return value;
}

/**
 * runtime resource key 的核心规则:隔离粒度决定容器按谁复用——
 * user→用户,workspace→工作区。这是唯一的判定处,下面两个 wrapper 只负责适配各自入参。
 */
export function runtimeResourceKey(
  isolationScope: string,
  userId: string,
  workspaceId: string
): string {
  if (isolationScope === "user") return userId;
  if (isolationScope === "workspace") return workspaceId;
  throw new Error(`Unknown runtime isolation scope: ${isolationScope}`);
}

/**
 * 从 placement 算 resource key。local 无容器复用语义,key 用 workspaceId 兜底；
 * sandbox 按隔离粒度走核心规则。
 */
export function runtimeResourceKeyForPlacement(
  placement: RuntimePlacement
): string {
  if (placement.runtimeType === "local") {
    return requirePlacementString(placement, "workspaceId");
  }
  return runtimeResourceKey(
    placement.sandbox.isolationScope,
    requirePlacementString(placement, "userId"),
    requirePlacementString(placement, "workspaceId")
  );
}

/** 从持久化的 RuntimeResource owner 记录算 resource key（容器存活台账侧用）。 */
export function runtimeResourceKeyForOwner(input: {
  isolationScope: string;
  ownerUserId: string;
  ownerWorkspaceId: string | null;
}): string {
  if (input.isolationScope === "workspace" && !input.ownerWorkspaceId) {
    throw new Error("Runtime resource ownerWorkspaceId is required");
  }
  return runtimeResourceKey(
    input.isolationScope,
    input.ownerUserId,
    input.ownerWorkspaceId ?? ""
  );
}

export function resolvedRuntimeResourceFromPlacement(
  placement: RuntimePlacement
): ResolvedRuntimeResource {
  return {
    runtimeType: requirePlacementString(placement, "runtimeType"),
    resourceKey: runtimeResourceKeyForPlacement(placement),
    workspaceId: requirePlacementString(placement, "workspaceId"),
    placement,
  };
}
