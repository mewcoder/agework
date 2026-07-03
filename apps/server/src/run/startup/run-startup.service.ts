import { Injectable, OnModuleInit } from "@nestjs/common";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import { WorkerRunExecutor } from "../execution/worker-run.executor";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerEventService } from "../upstream/worker-event.service";

@Injectable()
export class RunStartupService implements OnModuleInit {
  constructor(
    private readonly executor: WorkerRunExecutor,
    private readonly workerManager: WorkerManagerService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  onModuleInit(): void {
    this.executor.setRunEventPort(this.workerEvents);
    this.workerManager.setUpstreamPort(this.workerEvents);
    this.liveRuns.setTimeoutErrorPort(this.workerEvents);
  }
}
