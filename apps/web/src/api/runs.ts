import { apiGet } from "@/lib/http";
import type { RunStatus } from "@agework/shared";
import type {
  AdminRunDetailResponse,
  AdminRunEventListQuery,
  AdminRunEventListResponse,
  AdminRunEventResponse,
  AdminRunListQuery,
  AdminRunListResponse,
  AdminRunResponse,
} from "@agework/shared/api";

export type { RunStatus };
export type { AdminRunResponse as AdminRun };
export type { AdminRunDetailResponse as AdminRunDetail };
export type { AdminRunEventResponse as AdminRunEvent };
export type { AdminRunEventListQuery };
export type { AdminRunListResponse };

export const runsApi = {
  adminList: (params: AdminRunListQuery) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.pageNo) query.set("pageNo", String(params.pageNo));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    const qs = query.toString();
    return apiGet<AdminRunListResponse>(
      `/api/v1/admin/runs/list${qs ? `?${qs}` : ""}`
    );
  },
  adminQuery: (id: string) =>
    apiGet<AdminRunDetailResponse>(
      `/api/v1/admin/runs/query?id=${encodeURIComponent(id)}`
    ),
  adminEvents: (params: AdminRunEventListQuery) => {
    const query = new URLSearchParams();
    query.set("runId", params.runId);
    if (params.type?.length) query.set("type", params.type.join(","));
    if (params.typePrefix) query.set("typePrefix", params.typePrefix);
    if (params.origin?.length) query.set("origin", params.origin.join(","));
    if (params.targetType) query.set("targetType", params.targetType);
    if (params.targetId) query.set("targetId", params.targetId);
    if (params.chainId) query.set("chainId", params.chainId);
    if (params.refKey) query.set("refKey", String(params.refKey));
    if (params.refValue) query.set("refValue", params.refValue);
    if (params.fromRunSeq) query.set("fromRunSeq", String(params.fromRunSeq));
    if (params.toRunSeq) query.set("toRunSeq", String(params.toRunSeq));
    if (params.pageNo) query.set("pageNo", String(params.pageNo));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    return apiGet<AdminRunEventListResponse>(
      `/api/v1/admin/runs/events?${query.toString()}`
    );
  },
};
