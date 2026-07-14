import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RuntimeService } from "../../runtime/runtime.service";
import { StopWorkerKeyDto } from "./stop-worker-key.dto";
import { RUNTIME_HOST_CONTRACT } from "../runtime-host.types";
import type { RuntimeHostContract, WorkerKey } from "@agework/shared/protocol";

/**
 * Admin 运行资源诊断面：worker 现场查询(走 Host contract) + 运行策略查询。
 * Phase 3 清尾：Worker 表已删,admin 不再读库,全部走 contract 现场查询。
 */
@Controller("admin/worker")
@Roles("admin")
export class AdminWorkerController {
  constructor(
    private readonly runtimeService: RuntimeService,
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly hostContract: RuntimeHostContract
  ) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  @Get("stats")
  async getWorkerStats() {
    const workers = await this.hostContract.listWorkers();
    return {
      activeWorkers: workers.filter((w) => w.status === "running").length,
    };
  }

  /** Phase 3：唯一资源列表端点,现场查询 Host 上的 worker 快照。 */
  @Get("resources")
  async listResources() {
    return { list: await this.hostContract.listWorkers() };
  }

  /** Phase 3：唯一停止端点,通过 WorkerKey 停止 worker。 */
  @Post("resources/stop")
  async stopWorker(@Body() body: StopWorkerKeyDto) {
    await this.hostContract.stopWorker(body.workerKey as WorkerKey);
    return { ok: true };
  }
}
