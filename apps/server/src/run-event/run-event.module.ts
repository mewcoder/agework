import { Module } from "@nestjs/common";
import { RunEventRepository } from "./run-event.repository";
import { RunEventService } from "./run-event.service";
import { RunEventSeqStore } from "./seq/run-event-seq.store";
import { RawJsonlReader } from "./raw/raw-jsonl-reader";

/**
 * Run event ledger / diagnostics boundary.
 *
 * Run and worker execution code append semantic run events through
 * RunEventService; admin/read paths also go through RunEventService（委托
 * RunEventRepository）。模块拥有结构化事件持久化细节；原始 trace JSONL 由 worker
 * 侧写入本地文件，本模块只经 RawJsonlReader 只读查询，不负责写入。
 */
@Module({
  providers: [
    RunEventRepository,
    RunEventService,
    RunEventSeqStore,
    RawJsonlReader,
  ],
  exports: [RunEventService],
})
export class RunEventModule {}
