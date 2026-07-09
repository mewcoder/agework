import { Injectable, Logger } from "@nestjs/common";

export type WorkerHandshakeResult = {
  pid?: number;
  registeredAt: string;
};

type PendingHandshake = {
  token: string;
  resolve: (result: WorkerHandshakeResult) => void;
  reject: (reason: Error) => void;
};

/**
 * native 和 sandbox 两个 executor 共用的"等待 worker 主动回连注册"机制:
 * launch 拿到 runtime 载体(容器/进程)之后,不直接判定 running,而是先在这里
 * 挂一个 pending 握手,等 worker 进程真正跑起来、调用 register 端点带着匹配的
 * startToken 回连,才算确认活着。不自带超时——由调用方现有的 `withTimeout(...)`
 * 包裹。
 */
@Injectable()
export class WorkerHandshakeStore {
  private readonly logger = new Logger(WorkerHandshakeStore.name);
  private readonly pending = new Map<string, PendingHandshake>();

  waitForRegister(
    workerId: string,
    token: string
  ): Promise<WorkerHandshakeResult> {
    return new Promise<WorkerHandshakeResult>((resolve, reject) => {
      this.pending.set(workerId, { token, resolve, reject });
    });
  }

  /** launch 失败/超时后调用,清掉该 workerId 的 pending 握手,防止迟到的 register 命中。 */
  cancel(workerId: string, reason: string): void {
    const entry = this.pending.get(workerId);
    if (!entry) return;
    this.pending.delete(workerId);
    entry.reject(new Error(reason));
  }

  /** HTTP register 端点调用:token 匹配则 resolve 对应的 pending 握手。 */
  registerWorker(
    workerId: string,
    token: string,
    info: { pid?: number }
  ): boolean {
    const entry = this.pending.get(workerId);
    if (!entry || entry.token !== token) {
      this.logger.warn(
        `register rejected: no pending handshake or token mismatch for worker ${workerId}`
      );
      return false;
    }
    this.pending.delete(workerId);
    entry.resolve({ pid: info.pid, registeredAt: new Date().toISOString() });
    return true;
  }
}
