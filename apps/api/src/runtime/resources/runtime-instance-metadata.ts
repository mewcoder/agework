import type { RuntimePlacement } from "@agework/shared/protocol";
import type { Prisma } from "../../../generated/prisma/client.js";

type RuntimeInstanceMetadata = Record<string, unknown>;

export type RuntimeInstanceDiagnosticMetadata = RuntimeInstanceMetadata & {
  resourceKey: string;
  workspaceId?: string;
  statusReason: string;
  lastSeenAt: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  runtimeInstanceId?: string;
};

export function isMetadataRecord(
  metadata: unknown
): metadata is RuntimeInstanceMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  );
}

export function runningInstanceMetadata(input: {
  placement: RuntimePlacement;
  resourceKey: string;
  runtimeInstanceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    resourceKey: input.resourceKey,
    workspaceId: input.placement.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeInstanceId: input.runtimeInstanceId,
  };
}

export function stoppedInstanceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  resourceKey: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
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

export function statusInstanceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  resourceKey: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
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

export function runtimeInstanceDiagnostics(metadata: unknown) {
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
    runtimeInstanceId:
      typeof record.runtimeInstanceId === "string"
        ? record.runtimeInstanceId
        : undefined,
  };
}

export function runtimeInstanceMetadataJson(
  metadata: RuntimeInstanceDiagnosticMetadata
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}
