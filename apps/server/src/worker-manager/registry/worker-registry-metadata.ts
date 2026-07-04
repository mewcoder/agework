import type { Prisma } from "../../../generated/prisma/client.js";

type WorkerInstanceMetadata = Record<string, unknown>;

export type WorkerInstanceDiagnosticMetadata = WorkerInstanceMetadata & {
  ownerId: string;
  workspaceId?: string;
  statusReason: string;
  lastSeenAt: string;
  lastStartedAt?: string;
  stoppedAt?: string;
  runtimeInstanceId?: string;
};

export function isMetadataRecord(
  metadata: unknown
): metadata is WorkerInstanceMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
  );
}

export function runningInstanceMetadata(input: {
  workspaceId: string;
  ownerId: string;
  runtimeInstanceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): WorkerInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeInstanceId: input.runtimeInstanceId,
  };
}

export function stoppedInstanceMetadata(input: {
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): WorkerInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ownerId: input.ownerId,
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
  ownerId: string;
  reason: string;
  errorMessage?: string;
  now?: Date;
}): WorkerInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ownerId: input.ownerId,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    statusReason: input.reason,
    lastSeenAt: now,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

export function workerInstanceDiagnostics(metadata: unknown) {
  const record = isMetadataRecord(metadata) ? metadata : {};
  return {
    ownerId: typeof record.ownerId === "string" ? record.ownerId : undefined,
    workspaceId:
      typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    statusReason:
      typeof record.statusReason === "string" ? record.statusReason : undefined,
    lastSeenAt:
      typeof record.lastSeenAt === "string" ? record.lastSeenAt : undefined,
    lastStartedAt:
      typeof record.lastStartedAt === "string"
        ? record.lastStartedAt
        : undefined,
    stoppedAt:
      typeof record.stoppedAt === "string" ? record.stoppedAt : undefined,
    errorMessage:
      typeof record.errorMessage === "string" ? record.errorMessage : undefined,
    runtimeInstanceId:
      typeof record.runtimeInstanceId === "string"
        ? record.runtimeInstanceId
        : undefined,
  };
}

export function workerInstanceMetadataJson(
  metadata: WorkerInstanceDiagnosticMetadata
): Prisma.InputJsonValue {
  return metadata as Prisma.InputJsonValue;
}
