import { Controller, Get, Query } from "@nestjs/common";
import { Roles } from "../../auth/roles.decorator";
import { RunRecordService } from "../core/run-record.service";

@Controller("admin/runs")
@Roles("admin")
export class AdminRunController {
  constructor(private readonly runService: RunRecordService) {}

  @Get("list")
  listAdmin(
    @Query("status") status?: string,
    @Query("pageNo") pageNo?: string,
    @Query("pageSize") pageSize?: string
  ) {
    const take = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
    const pageNum = Math.max(Number(pageNo) || 1, 1);
    return this.runService.listAdmin({
      status: status || undefined,
      take,
      skip: (pageNum - 1) * take,
    });
  }

  @Get("query")
  query(@Query("id") id: string) {
    return this.runService.detailAdmin(id);
  }

  @Get("events")
  listEvents(
    @Query("runId") runId: string,
    @Query("source") source?: string,
    @Query("eventType") eventType?: string,
    @Query("level") level?: string,
    @Query("pageNo") pageNo?: string,
    @Query("pageSize") pageSize?: string
  ) {
    // 事件列表按单次 run 取全量在前端筛选/虚拟滚动，不再分页，上限仅用于兜底。
    const take = Math.min(Math.max(Number(pageSize) || 20, 1), 5000);
    const pageNum = Math.max(Number(pageNo) || 1, 1);
    // source / level 支持逗号分隔多选；解析成数组去空，空数组视为不过滤。
    return this.runService.listAdminEvents({
      runId,
      source: parseMulti(source),
      eventType: eventType || undefined,
      level: parseMulti(level),
      take,
      skip: (pageNum - 1) * take,
    });
  }
}

/**
 * 解析多选 query 参数，兼容逗号分隔（`"agui,runtime"`）和标准重复 key 数组格式
 * （NestJS 对 `?source=a&source=b` 会解析成 `string[]`）。
 */
function parseMulti(value?: string | string[]): string[] | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value : value.split(",");
  const items = raw.map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
