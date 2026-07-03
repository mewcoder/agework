import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import { workerInstanceDiagnostics } from "./worker-registry-metadata";

// WorkerInstance 行的管理端响应组装(纯函数)。行形状由 WorkerRegistryRepository
// 的查询 select 决定,这里只消费。

type WorkspaceWorkerBindingRow = {
  id: string;
  workspaceId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type WorkerInstanceRow = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  runtimeInstanceId: string;
  status: string;
  expiresAt: Date | string | null;
  metadata: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  workspaceWorkerBindings?: WorkspaceWorkerBindingRow[];
};

/** 管理端 runtime 资源列表行:附 isReusable / workspaceCount / diagnostics 汇总。 */
export function toRuntimeInstanceResponse(resource: WorkerInstanceRow) {
  const diagnostics = workerInstanceDiagnostics(resource.metadata);
  const workspaceRuntimes = resource.workspaceWorkerBindings?.map(
    toWorkspaceRuntimeBinding
  );

  return {
    id: resource.id,
    runtimeType: resource.runtimeType,
    isolationScope: resource.isolationScope,
    ownerId: resource.ownerId,
    runtimeInstanceId: resource.runtimeInstanceId,
    status: resource.status,
    isReusable: resource.status === "running",
    workspaceCount: workspaceRuntimes?.length ?? 0,
    expiresAt: resource.expiresAt ? toIsoString(resource.expiresAt) : null,
    metadata: resource.metadata,
    diagnostics: {
      ...diagnostics,
      ownerId: diagnostics.ownerId ?? resource.ownerId,
      runtimeInstanceId:
        diagnostics.runtimeInstanceId ?? resource.runtimeInstanceId,
    },
    createdAt: toIsoString(resource.createdAt),
    updatedAt: toIsoString(resource.updatedAt),
    workspaceRuntimes,
  };
}

/** 管理端 run 详情里的 runtime 实例视图(findRunInstanceView 的行,不含 metadata)。 */
export function toAdminRuntimeInstanceResponse(
  record: Omit<WorkerInstanceRow, "metadata" | "workspaceWorkerBindings"> & {
    workspaceWorkerBindings: WorkspaceWorkerBindingRow[];
  }
): AdminRunRuntimeInstanceResponse {
  const { workspaceWorkerBindings, ...resource } = record;
  return {
    ...resource,
    expiresAt: resource.expiresAt ? toIsoString(resource.expiresAt) : null,
    createdAt: toIsoString(resource.createdAt),
    updatedAt: toIsoString(resource.updatedAt),
    workspaceRuntimes: workspaceWorkerBindings.map(toWorkspaceRuntimeBinding),
  };
}

function toWorkspaceRuntimeBinding(binding: WorkspaceWorkerBindingRow) {
  return {
    id: binding.id,
    workspaceId: binding.workspaceId,
    createdAt: toIsoString(binding.createdAt),
    updatedAt: toIsoString(binding.updatedAt),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
