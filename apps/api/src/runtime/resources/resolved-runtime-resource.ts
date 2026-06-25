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
 * 计算 runtime resource key：sandbox 下按隔离粒度（user→userId / workspace→workspaceId）
 * 确定容器复用归属；local 无容器复用语义，resourceKey 不被消费，用 workspaceId 兜底。
 */
export function runtimeResourceKeyForPlacement(
  placement: RuntimePlacement
): string {
  if (placement.runtimeType === "local") {
    return requirePlacementString(placement, "workspaceId");
  }

  const isolationScope = placement.sandbox?.isolationScope;
  if (isolationScope === "user") {
    return requirePlacementString(placement, "userId");
  }

  if (isolationScope === "workspace") {
    return requirePlacementString(placement, "workspaceId");
  }

  throw new Error(`Unknown runtime isolation scope: ${isolationScope}`);
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
