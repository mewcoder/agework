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
    if (params.source?.length) query.set("source", params.source.join(","));
    if (params.eventType) query.set("eventType", params.eventType);
    if (params.level?.length) query.set("level", params.level.join(","));
    if (params.pageNo) query.set("pageNo", String(params.pageNo));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    return apiGet<AdminRunEventListResponse>(
      `/api/v1/admin/runs/events?${query.toString()}`
    );
  },
};
