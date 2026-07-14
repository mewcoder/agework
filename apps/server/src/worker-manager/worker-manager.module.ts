import { Module } from "@nestjs/common";

import { RuntimeModule } from "../runtime/runtime.module";
import { RunEventModule } from "../run-event/run-event.module";
import { RuntimeHostAdapter } from "./contract/runtime-host.adapter";
import { managedRuntimeHostProvider } from "./contract/managed-runtime-host";
import { WorkspaceHostListener } from "./contract/workspace-host.listener";
import { RUNTIME_HOST_CONTRACT } from "./worker-manager.types";
import { AdminWorkerController } from "./admin/admin-worker.controller";

/**
 * Phase 3 清尾后：worker-manager 模块只剩 contract 实现 + admin 观测面。
 *
 * 旧 worker-manager 执行栈（connection/instance/registry）、旧 /worker/* 端点、
 * WorkerManagerService 已全部删除。worker 数据面由 builtin Host 自管的
 * WorkerHttpServer 承接（registered Host 各自的 WorkerHttpServer）。
 *
 * 公开面只暴露 RUNTIME_HOST_CONTRACT token（run 模块经它消费执行面）。
 * admin 观测面走 AdminWorkerController（contract 现场查询）。
 */
@Module({
  imports: [RuntimeModule, RunEventModule],
  controllers: [AdminWorkerController],
  providers: [
    managedRuntimeHostProvider,
    RuntimeHostAdapter,
    WorkspaceHostListener,
    { provide: RUNTIME_HOST_CONTRACT, useExisting: RuntimeHostAdapter },
  ],
  exports: [RUNTIME_HOST_CONTRACT],
})
export class WorkerManagerModule {}
