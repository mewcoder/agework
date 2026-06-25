import { Injectable } from "@nestjs/common";
import type { ControlPayload } from "@agework/shared/protocol";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import type {
  RunWorkerExecutionStartInput,
  WorkerExecutionHandle,
} from "./run-worker-execution.types";

/**
 * Run 层拥有的 worker execution 边界：把 RuntimeResource + RunConfig 组装成一次
 * worker 执行，并维护 runId → handle 的派发表，下发 control / cancel / cleanup。
 *
 * worker 的物理启动（local fork / sandbox 容器会话）仍在 runtime provider 内实现，
 * 这里只按 runtimeType 解析 provider 并驱动其 WorkerExecutionProvider 契约——
 * 即「Run 驱动执行」，区别于「Runtime 准备环境」(RuntimeService.resolveRuntimeResource)。
 */
@Injectable()
export class RunWorkerExecutionService {
  private readonly handles = new Map<string, WorkerExecutionHandle>();

  constructor(private readonly providerRegistry: RuntimeProviderRegistry) {}

  start(input: RunWorkerExecutionStartInput): WorkerExecutionHandle {
    const provider = this.providerRegistry.resolve(
      input.runtimeResource.runtimeType
    );
    const handle = provider.startWorkerExecution(input);
    this.handles.set(handle.runId, handle);
    return handle;
  }

  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void {
    this.providerRegistry.resolve(handle.runtimeType).sendControl(handle, control);
  }

  cancel(handle: WorkerExecutionHandle): void {
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
