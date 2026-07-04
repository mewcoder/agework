import { Injectable, OnModuleInit } from "@nestjs/common";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import { RunDriver } from "../driver/run-driver";
import { LiveRunRegistry } from "../live-run/live-run.registry";
import { WorkerEventService } from "../upstream/worker-event.service";

@Injectable()
export class RunStartupService implements OnModuleInit {
  constructor(
    private readonly driver: RunDriver,
    private readonly workerManager: WorkerManagerService,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerEvents: WorkerEventService
  ) {}

  onModuleInit(): void {
    this.driver.setRunEventPort(this.workerEvents);
    this.workerManager.setUpstreamPort(this.workerEvents);
    this.liveRuns.setTimeoutErrorPort(this.workerEvents);
  }
}
