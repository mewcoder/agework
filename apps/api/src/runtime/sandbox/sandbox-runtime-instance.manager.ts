import { Injectable } from "@nestjs/common";
import type {
  RuntimeInstanceManager,
  RuntimeOwnerSessionCleanup,
} from "../providers/provider-contracts";
import { SandboxRuntimeInstanceService } from "./sandbox-instance.service";

@Injectable()
export class SandboxRuntimeInstanceManager implements RuntimeInstanceManager {
  readonly type = "sandbox" as const;
  private cleanupOwnerSession: RuntimeOwnerSessionCleanup = () => undefined;

  constructor(
    private readonly runtimeInstances: SandboxRuntimeInstanceService
  ) {}

  setOwnerSessionCleanup(cleanup: RuntimeOwnerSessionCleanup): void {
    this.cleanupOwnerSession = cleanup;
  }

  shutdownRuntimeInstance(ownerId: string): void {
    this.runtimeInstances.shutdownRuntimeInstance(ownerId, {
      cleanupByOwnerId: this.cleanupOwnerSession,
    });
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeInstances.recoverOrphan(runtimeInstanceId);
  }
}
