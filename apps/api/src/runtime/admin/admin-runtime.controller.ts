import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RuntimeService } from "../runtime.service";
import { RuntimeInstanceIdDto } from "./runtime-instance-id.dto";
import { AdminRuntimeResourcesQueryDto } from "./admin-runtime-query.dto";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(private readonly runtimeService: RuntimeService) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  @Get("stats")
  getRuntimeStats() {
    return this.runtimeService.getRuntimeStats();
  }

  @Get("resources")
  listResources(@Query() query: AdminRuntimeResourcesQueryDto) {
    return this.runtimeService.listRuntimeResources(query);
  }

  @Post("resources/stop")
  stopResource(@Body() body: RuntimeInstanceIdDto) {
    return this.runtimeService.stopRuntimeInstance(body.id);
  }
}
