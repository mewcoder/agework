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

  onModuleInit(): void {
    this.executionService.setRunEventPort(this.workerEvents);
    this.workerHost.setUpstreamPort(this.workerEvents);
    this.liveRuns.setTimeoutErrorPort(this.workerEvents);
  }
}
