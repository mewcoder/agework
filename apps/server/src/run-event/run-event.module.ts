import { Module } from "@nestjs/common";
import { RunEventRepository } from "./run-event.repository";
import { RunEventService } from "./run-event.service";
import { RunEventSeqStore } from "./seq/run-event-seq.store";

/**
 * Run event ledger / diagnostics boundary.
 *
 * Run and worker execution code append semantic run events through
 * RunEventService; admin/read paths also go through RunEventService（委托
 * RunEventRepository）。模块拥有结构化事件持久化细节，不拥有 run 生命周期状态或
 * 原始 trace 文件写入。
 */
@Module({
  providers: [RunEventRepository, RunEventService, RunEventSeqStore],
  exports: [RunEventService],
})
export class RunEventModule {}
