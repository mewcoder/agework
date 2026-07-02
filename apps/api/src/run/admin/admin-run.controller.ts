import { Controller, Get, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RunService } from "../run.service";
import { pageWindow } from "../../common/dto/pagination-query.dto";
import { AdminRunEventsQueryDto } from "./admin-run-events-query.dto";
import { AdminRunListQueryDto } from "./admin-run-list-query.dto";
import { RunIdDto } from "./run-id.dto";

@Controller("admin/runs")
@Roles("admin")
export class AdminRunController {
  constructor(private readonly runService: RunService) {}

  @Get("list")
  listAdmin(@Query() query: AdminRunListQueryDto) {
    const { take, skip } = pageWindow(query);
    return this.runService.listForAdmin({ status: query.status, take, skip });
  }

  @Get("query")
  query(@Query() query: RunIdDto) {
    return this.runService.getDetailForAdmin(query.id);
  }

  @Get("events/list")
  listEvents(@Query() query: AdminRunEventsQueryDto) {
    // 事件列表按单次 run 取全量在前端筛选/虚拟滚动，不再分页，上限仅用于兜底。
    const { take, skip } = pageWindow(query, {
      defaultPageSize: 20,
      maxPageSize: 5000,
    });
    return this.runService.listEventsForAdmin({
      runId: query.runId,
      type: query.type,
      typePrefix: query.typePrefix,
      origin: query.origin,
      targetType: query.targetType,
      targetId: query.targetId,
      chainId: query.chainId,
      refKey: query.refKey,
      refValue: query.refValue,
      fromRunSeq: query.fromRunSeq,
      toRunSeq: query.toRunSeq,
      take,
      skip,
    });
  }
}
