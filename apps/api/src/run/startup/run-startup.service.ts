import { Injectable, OnModuleInit } from "@nestjs/common";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { ExecutionService } from "../execution/execution.service";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerEventService } from "../worker-event/worker-event.service";

@Injectable()
export class RunStartupService implements OnModuleInit {
  constructor(
    private readonly executionService: ExecutionService,
    private readonly workerHost: WorkerHostService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  async onModuleInit(): Promise<void> {
    this.executionService.setRunEventReceiver(this.workerEvents);
    this.workerHost.setCommandSentPort(this.workerEvents);
    this.workerHost.setUpstreamPort(this.workerEvents);
    this.liveRuns.setTimeoutErrorSink(this.workerEvents);
  }
}
