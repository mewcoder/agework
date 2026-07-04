import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { WorkerManagerService } from "../worker-manager.service";
import { WorkerInstanceIdDto } from "./worker-instance-id.dto";
import { AdminWorkerResourcesQueryDto } from "./admin-worker-query.dto";

@Controller("admin/worker")
@Roles("admin")
export class AdminWorkerController {
  constructor(private readonly workerManager: WorkerManagerService) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.workerManager.getRuntimePolicy();
  }

  @Get("stats")
  getWorkerStats() {
    return this.workerManager.getWorkerStats();
  }

  @Get("resources")
  listResources(@Query() query: AdminWorkerResourcesQueryDto) {
    return this.workerManager.listResources(query);
  }

  @Post("resources/stop")
  stopResource(@Body() body: WorkerInstanceIdDto) {
    return this.workerManager.stopWorkerInstance(body.id);
  }
}
