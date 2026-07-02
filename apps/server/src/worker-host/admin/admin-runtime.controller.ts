import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { WorkerHostService } from "../worker-host.service";
import { RuntimeInstanceIdDto } from "./runtime-instance-id.dto";
import { AdminRuntimeResourcesQueryDto } from "./admin-runtime-query.dto";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(private readonly workerHost: WorkerHostService) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.workerHost.getRuntimePolicy();
  }

  @Get("stats")
  getRuntimeStats() {
    return this.workerHost.getRuntimeStats();
  }

  @Get("resources")
  listResources(@Query() query: AdminRuntimeResourcesQueryDto) {
    return this.workerHost.listResources(query);
  }

  @Post("resources/stop")
  stopResource(@Body() body: RuntimeInstanceIdDto) {
    return this.workerHost.stopRuntimeInstance(body.id);
  }
}
