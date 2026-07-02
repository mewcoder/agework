import { Injectable, OnModuleInit } from "@nestjs/common";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { WorkerRunExecutor } from "../execution/worker-run.executor";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerEventService } from "../upstream/worker-event.service";

@Injectable()
export class RunStartupService implements OnModuleInit {
  constructor(
    private readonly executor: WorkerRunExecutor,
    private readonly workerHost: WorkerHostService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  onModuleInit(): void {
    this.executor.setRunEventPort(this.workerEvents);
    this.workerHost.setUpstreamPort(this.workerEvents);
    this.liveRuns.setTimeoutErrorPort(this.workerEvents);
  }
}
