import { Injectable } from "@nestjs/common";
import type { RuntimeInstanceManager } from "./provider-contracts";

/**
 * local runtime 没有可复用 runtime resource；这里只处理服务重启后的
 * legacy/local worker pid 清理。
 */
@Injectable()
export class LocalRuntimeInstanceManager implements RuntimeInstanceManager {
  readonly type = "local" as const;

  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
  }
}
