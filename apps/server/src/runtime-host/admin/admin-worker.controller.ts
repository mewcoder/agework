import { Body, Controller, Get, Post } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { RuntimeHostService } from "../runtime-host.service";
import { StopWorkerDto } from "../dto/stop-worker.dto";

/**
 * Admin 运行资源诊断面：worker 现场查询 + 定向停止,统一经 RuntimeHostService 根
 * Service 编排(不直接注入执行面契约)。Phase 3 清尾:Worker 表已删,全部走
 * contract 现场查询。
 */
@Controller("admin/runtime-hosts/workers")
@Roles("admin")
export class AdminWorkerController {
  constructor(private readonly runtimeHostService: RuntimeHostService) {}

  /** Phase 3：唯一资源列表端点,现场查询 Host 上的 worker 快照。 */
  @Get("list")
  list() {
    return this.runtimeHostService.listWorkersForAdmin();
  }

  /** Phase 3:唯一停止端点,按 runtimeHostId 定向停止目标 Host 上的 worker。 */
  @Post("stop")
  async stop(@Body() body: StopWorkerDto) {
    await this.runtimeHostService.stopWorkerForAdmin(
      body.runtimeHostId,
      body.workerKey
    );
    return { ok: true };
  }
}
