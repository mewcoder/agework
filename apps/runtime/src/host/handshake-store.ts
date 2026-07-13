/**
 * worker 启动握手存储：launch 拿到载体后挂 pending 握手，等 worker 进程回连注册
 * 带匹配 startToken 才确认活着。不自带超时——由调用方包裹 withTimeout。
 *
 * 收编自 worker-manager/connection/worker-handshake.store.ts，去掉 NestJS 依赖。
 */
export class HandshakeStore {
  private readonly pending = new Map<
    string,
    {
      token: string;
      resolve: (result: { pid?: number; registeredAt: string }) => void;
      reject: (reason: Error) => void;
    }
  >();

  /** 挂一个 pending 握手，等 worker 回连注册。 */
  waitForRegister(
    workerId: string,
    token: string
  ): Promise<{ pid?: number; registeredAt: string }> {
    return new Promise((resolve, reject) => {
      this.pending.set(workerId, { token, resolve, reject });
    });
  }

  /** launch 失败/超时后清除 pending，防止迟到的 register 命中。 */
  cancel(workerId: string, reason: string): void {
    const entry = this.pending.get(workerId);
    if (!entry) return;
    this.pending.delete(workerId);
    entry.reject(new Error(reason));
  }

  /** worker 回连注册：token 匹配则 resolve pending 握手。 */
  registerWorker(
    workerId: string,
    token: string,
    info: { pid?: number }
  ): boolean {
    const entry = this.pending.get(workerId);
    if (!entry || entry.token !== token) return false;
    this.pending.delete(workerId);
    entry.resolve({ pid: info.pid, registeredAt: new Date().toISOString() });
    return true;
  }
}
