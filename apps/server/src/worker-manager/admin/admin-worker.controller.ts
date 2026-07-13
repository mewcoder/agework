import { Body, Controller, Get, Inject, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { WorkerManagerService } from "../worker-manager.service";
import { WorkerInstanceIdDto } from "./worker-instance-id.dto";
import { StopWorkerKeyDto } from "./stop-worker-key.dto";
import { AdminWorkerResourcesQueryDto } from "./admin-worker-query.dto";
import { RUNTIME_HOST_CONTRACT } from "../worker-manager.types";
import type { RuntimeHostContract, WorkerKey } from "@agework/shared/protocol";

@Controller("admin/worker")
@Roles("admin")
export class AdminWorkerController {
  constructor(
    private readonly workerManager: WorkerManagerService,
    @Inject(RUNTIME_HOST_CONTRACT) private readonly hostContract: RuntimeHostContract
  ) {}

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

  /** Phase 2: 现场查询 Host 上的 worker 快照（不入库，不依赖 Worker 表）。 */
  @Get("resources/live")
  async listLiveWorkers() {
    return { list: await this.hostContract.listWorkers() };
  }

  @Post("resources/stop")
  stopResource(@Body() body: WorkerInstanceIdDto) {
    return this.workerManager.stopWorkerInstance(body.id);
  }

  /** Phase 2: 通过 WorkerKey 停止 worker（走 hostContract.stopWorker，覆盖 managed + registered）。 */
  @Post("resources/stop-live")
  async stopLiveWorker(@Body() body: StopWorkerKeyDto) {
    await this.hostContract.stopWorker(body.workerKey as WorkerKey);
    return { ok: true };
  }
}
