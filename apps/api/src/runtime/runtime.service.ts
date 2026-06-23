import { Injectable } from "@nestjs/common";
import type {
  ControlPayload,
  RunConfig,
  RuntimeHandle,
  RuntimePlacement,
} from "@agework/shared/protocol";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";

type ResolvePlacementInput = Parameters<
  RuntimePlacementPolicy["resolveForRun"]
>[0];

/**
 * Runtime 层对上层（run 层）的唯一门面：placement 解析 + per-run worker 环境
 * 的启动/控制/取消/心跳/清理。内部把现有 RuntimePlacementPolicy /
 * RuntimeProviderRegistry 包一层，并按 runId 记一张 handle 表，使 heartbeat /
 * cleanup 只凭 runId 即可派发到对应 provider（上层无需持有 RuntimeHandle）。
 *
 * 本步（Step C）只建门面，调用方暂不切；RunRunner / 内部 controller 仍走旧路径。
 */
@Injectable()
export class RuntimeService {
  private readonly handles = new Map<string, RuntimeHandle>();

  constructor(
    private readonly placementPolicy: RuntimePlacementPolicy,
    private readonly providerRegistry: RuntimeProviderRegistry
  ) {}

  resolvePlacement(input: ResolvePlacementInput): RuntimePlacement {
    return this.placementPolicy.resolveForRun(input);
  }

  startWorker(
    runConfig: RunConfig,
    placement: RuntimePlacement,
    onRuntimeResourceIdReady?: (runtimeResourceId: string) => void
  ): RuntimeHandle {
    const handle = this.providerRegistry
      .resolve(placement.runtimeType)
      .start(runConfig, placement, onRuntimeResourceIdReady);
    this.handles.set(handle.runId, handle);
    return handle;
  }

  sendControl(handle: RuntimeHandle, control: ControlPayload): void {
    this.providerRegistry
      .resolve(handle.runtimeType)
      .sendControl(handle, control);
  }

  cancel(handle: RuntimeHandle): void {
    this.providerRegistry.resolve(handle.runtimeType).cancel(handle);
  }

  heartbeat(runId: string): void {
    this.providerForRun(runId)?.heartbeat(runId);
  }

  cleanup(runId: string): void {
    this.providerForRun(runId)?.cleanup(runId);
    this.handles.delete(runId);
  }

  private providerForRun(runId: string) {
    const handle = this.handles.get(runId);
    return handle
      ? this.providerRegistry.resolve(handle.runtimeType)
      : undefined;
  }
}
