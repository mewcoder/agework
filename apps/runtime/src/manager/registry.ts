export type LiveCarrier = {
  runtimeInstanceId: string;
  isolationScope: string;
};

/**
 * 本机活载体记录:launcher 起/停/毁时维护,纯粹是"当前这台机器上活着哪些载体"的
 * 台账,供后续诊断/监督读取。不做心跳判死——判死真源在 server(见执行文档 §9)。
 */
export class LiveCarrierStore {
  private readonly carriers = new Map<string, LiveCarrier>();

  record(ownerId: string, carrier: LiveCarrier): void {
    this.carriers.set(ownerId, carrier);
  }

  remove(ownerId: string): void {
    this.carriers.delete(ownerId);
  }

  get(ownerId: string): LiveCarrier | undefined {
    return this.carriers.get(ownerId);
  }

  list(): ReadonlyMap<string, LiveCarrier> {
    return this.carriers;
  }
}
