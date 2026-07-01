import { Injectable } from "@nestjs/common";
import type { RuntimeInstanceManager } from "../providers/provider-contracts";
import { SandboxRuntimeInstanceService } from "./sandbox-instance.service";

@Injectable()
export class SandboxRuntimeInstanceManager implements RuntimeInstanceManager {
  readonly type = "sandbox" as const;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService
  ) {}

  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    this.runtimeInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }
}
