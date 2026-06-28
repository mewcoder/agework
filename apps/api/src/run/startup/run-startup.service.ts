import { Injectable, OnModuleInit } from "@nestjs/common";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { ExecutionService } from "../execution/execution.service";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerEventService } from "../worker-event/worker-event.service";

@Injectable()
export class RunStartupService implements OnModuleInit {
  constructor(
    private readonly executionService: ExecutionService,
    private readonly runtimeService: RuntimeService,
    private readonly workerHost: WorkerHostService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  async onModuleInit(): Promise<void> {
    this.executionService.setRunEventReceiver(this.workerEvents);
    this.runtimeService.setSandboxOwnerSessionCleanup((ownerId) =>
      this.workerHost.cleanupByOwnerId(ownerId)
    );
    this.workerHost.setCommandSentRecorder(this.workerEvents);
    this.workerHost.setReceiver(this.workerEvents);
    this.liveRuns.setTimeoutErrorSink(this.workerEvents);
  }
}
