import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { WorkerManagerService } from "../worker-manager.service";
import { RuntimeInstanceIdDto } from "./runtime-instance-id.dto";
import { AdminRuntimeResourcesQueryDto } from "./admin-runtime-query.dto";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(private readonly workerManager: WorkerManagerService) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.workerManager.getRuntimePolicy();
  }

  @Get("stats")
  getRuntimeStats() {
    return this.workerManager.getRuntimeStats();
  }

  @Get("resources")
  listResources(@Query() query: AdminRuntimeResourcesQueryDto) {
    return this.workerManager.listResources(query);
  }

  @Post("resources/stop")
  stopResource(@Body() body: RuntimeInstanceIdDto) {
    return this.workerManager.stopRuntimeInstance(body.id);
  }
}
