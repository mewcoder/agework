import { Inject, Injectable } from "@nestjs/common";
import type { RunEventPort, RunExecutor } from "./executor";

export const RUN_EXECUTORS = Symbol("RUN_EXECUTORS");

/**
 * runs 层的 run executor registry。
 *
 * 只负责 per-run execution：按 runtimeType 分发到 local/sandbox 的执行实现。
 * runtime resource 的 recover/shutdown 留在各 run executor 内部转发 worker-host / runtime。
 */
@Injectable()
export class RunExecutorRegistry {
  private readonly executors: Map<string, RunExecutor>;

  constructor(@Inject(RUN_EXECUTORS) executors: RunExecutor[]) {
    this.executors = new Map(
      executors.map((executor) => [executor.type, executor])
    );
  }

  resolve(type: string): RunExecutor {
    const executor = this.executors.get(type);
    if (!executor) {
      throw new Error(`Unknown run executor: ${type}`);
    }
    return executor;
  }

  setRunEventPort(receiver: RunEventPort): void {
    for (const executor of this.executors.values()) {
      executor.setRunEventPort(receiver);
    }
  }
}
