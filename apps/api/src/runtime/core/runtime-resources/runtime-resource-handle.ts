import type {
  RuntimePlacement,
  RuntimeResourceHandle,
} from "@agework/shared/protocol";

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

export function runtimeResourceKeyForPlacement(
  placement: RuntimePlacement
): string {
  if (placement.isolationScope === "user") {
    return requirePlacementString(placement, "userId");
  }

  if (placement.isolationScope === "workspace") {
    return requirePlacementString(placement, "workspaceId");
  }

  throw new Error(`Unknown runtime isolation scope: ${placement.isolationScope}`);
}

export function runtimeResourceHandleFromPlacement(
  placement: RuntimePlacement
): RuntimeResourceHandle {
  return {
    runtimeType: requirePlacementString(placement, "runtimeType"),
    resourceKey: runtimeResourceKeyForPlacement(placement),
    workspaceId: requirePlacementString(placement, "workspaceId"),
    isolationScope: placement.isolationScope,
    placement,
  };
}
