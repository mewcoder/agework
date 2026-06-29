import { Injectable } from "@nestjs/common";
import type { RuntimeInstanceManager } from "../providers/provider-contracts";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { SandboxRuntimeInstanceService } from "./sandbox-instance.service";

@Injectable()
export class SandboxRuntimeInstanceManager implements RuntimeInstanceManager {
  readonly type = "sandbox" as const;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService,
    private readonly workerHost: WorkerHostService
  ) {}

  shutdownRuntimeInstance(ownerId: string): void {
    this.runtimeInstances.shutdownRuntimeInstance(ownerId, {
      cleanupByOwnerId: (id) => this.workerHost.cleanupByOwnerId(id),
    });
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }
}
