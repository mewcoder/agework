import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
} from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { StopWorkerDto } from "./stop-worker.dto";
import { RUNTIME_HOST_DIAGNOSTICS } from "../runtime-host.types";
import type {
  RuntimeHostDiagnostics,
  WorkerKey,
} from "@agework/shared/protocol";

/**
 * Admin 运行资源诊断面：worker 现场查询(走 Host contract) + 运行策略查询。
 * Phase 3 清尾：Worker 表已删,admin 不再读库,全部走 contract 现场查询。
 */
@Controller("admin/runtime-hosts/workers")
@Roles("admin")
export class AdminWorkerController {
  constructor(
    @Inject(RUNTIME_HOST_DIAGNOSTICS)
    private readonly hostContract: RuntimeHostDiagnostics
  ) {}

  /** Phase 3：唯一资源列表端点,现场查询 Host 上的 worker 快照。 */
  @Get("list")
  async list() {
    return { list: await this.hostContract.listWorkers() };
  }

  /** Phase 3:唯一停止端点,按 runtimeHostId 定向停止目标 Host 上的 worker。 */
  @Post("stop")
  async stop(@Body() body: StopWorkerDto) {
    try {
      await this.hostContract.stopWorker({
        runtimeHostId: body.runtimeHostId,
        key: body.workerKey as WorkerKey,
      });
    } catch (err) {
      // 目标 Host 离线/超时是预期失败,按上游不可达报告
      throw new BadGatewayException(
        `stop worker failed on host ${body.runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    return { ok: true };
  }
}
