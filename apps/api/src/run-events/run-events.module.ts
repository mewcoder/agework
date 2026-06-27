import { Module } from "@nestjs/common";
import { RunEventQuery } from "./run-event.query";
import { RunEventRepository } from "./run-event.repository";
import { RunEventService } from "./run-event.service";

/**
 * Run event ledger / diagnostics boundary.
 *
 * Run and worker execution code can append semantic run events through
 * RunEventService, while admin/read paths use RunEventQuery. The module owns
 * structured event persistence details; it does not own run lifecycle state or
 * raw trace-file writing.
 */
@Module({
  providers: [
    RunEventRepository,
    RunEventService,
    RunEventQuery,
  ],
  exports: [RunEventService, RunEventQuery],
})
export class RunEventsModule {}
