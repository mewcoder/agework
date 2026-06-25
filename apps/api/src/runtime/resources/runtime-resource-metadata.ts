import type { RuntimePlacement } from "@agework/shared/protocol";
import type { Prisma } from "../../../generated/prisma/client.js";

type RuntimeResourceMetadata = Record<string, unknown>;

export type RuntimeResourceDiagnosticMetadata = RuntimeResourceMetadata & {
  resourceKey: string;
  workspaceId?: string;
  statusReason: string;
  lastSeenAt: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  runtimeResourceId?: string;
};

export function isMetadataRecord(
  metadata: unknown
): metadata is RuntimeResourceMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  );
}

export function runningResourceMetadata(input: {
  placement: RuntimePlacement;
  resourceKey: string;
  runtimeResourceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): RuntimeResourceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    resourceKey: input.resourceKey,
    workspaceId: input.placement.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeResourceId: input.runtimeResourceId,
  };
}

export function stoppedResourceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  resourceKey: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeResourceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    resourceKey: input.resourceKey,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    statusReason: input.reason,
    lastSeenAt: now,
    stoppedAt: now,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

export function statusResourceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  resourceKey: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeResourceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    resourceKey: input.resourceKey,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    statusReason: input.reason,
    lastSeenAt: now,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

export function runtimeResourceDiagnostics(metadata: unknown) {
  const record = isMetadataRecord(metadata) ? metadata : {};
  return {
    resourceKey:
      typeof record.resourceKey === "string" ? record.resourceKey : undefined,
    workspaceId:
      typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    statusReason:
      typeof record.statusReason === "string"
        ? record.statusReason
        : undefined,
    lastSeenAt:
      typeof record.lastSeenAt === "string" ? record.lastSeenAt : undefined,
    lastStartedAt:
      typeof record.lastStartedAt === "string"
        ? record.lastStartedAt
        : undefined,
    stoppedAt:
      typeof record.stoppedAt === "string" ? record.stoppedAt : undefined,
    errorMessage:
      typeof record.errorMessage === "string"
        ? record.errorMessage
        : undefined,
    runtimeResourceId:
      typeof record.runtimeResourceId === "string"
        ? record.runtimeResourceId
        : undefined,
  };
}

export function runtimeResourceMetadataJson(
  metadata: RuntimeResourceDiagnosticMetadata
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}
