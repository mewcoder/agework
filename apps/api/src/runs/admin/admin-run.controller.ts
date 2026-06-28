import { Controller, Get, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RunRepository } from "../run.repository";
import { RunEventQuery } from "../../run-events/run-event.query";
import { pageWindow } from "../../common/dto/pagination-query.dto";
import {
  AdminRunEventsQueryDto,
  AdminRunIdQueryDto,
  AdminRunListQueryDto,
} from "./admin-run-query.dto";

@Controller("admin/runs")
@Roles("admin")
export class AdminRunController {
  constructor(
    private readonly runRepository: RunRepository,
    private readonly runEventQueryService: RunEventQuery
  ) {}

  @Get("list")
  listAdmin(@Query() query: AdminRunListQueryDto) {
    const { take, skip } = pageWindow(query);
    return this.runRepository.listAdmin({
      status: query.status,
      take,
      skip,
    });
  }

  @Get("query")
  query(@Query() query: AdminRunIdQueryDto) {
    return this.runRepository.detailAdmin(query.id);
  }

  @Get("events")
  listEvents(@Query() query: AdminRunEventsQueryDto) {
    // 事件列表按单次 run 取全量在前端筛选/虚拟滚动，不再分页，上限仅用于兜底。
    const { take, skip } = pageWindow(query, {
      defaultPageSize: 20,
      maxPageSize: 5000,
    });
    return this.runEventQueryService.listAdminEvents({
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
