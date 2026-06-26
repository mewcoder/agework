/**
 * Runtime 对外的鉴权通道抽象：runtime provider 启动容器时需要一把 access key
 * 塞进 worker env（供 worker 反向调 API 鉴权），并在容器实例销毁时撤销。
 * runtime 不认识具体实现（key 表存哪、怎么签），由 run 层把 worker-host 的
 * WorkerAccessService 包成此接口注入。
 *
 * 与 CommandPort 同理：runtime 与 worker 通信基础设施无本质关联，鉴权 key 的
 * 家在 worker-host，runtime 只「领 key 用 + 用完撤销」，由 run 负责绑定。
 */
export interface AccessPort {
  /** 为 runtime owner 签发/获取内部访问 key，供 worker 反向调 API 鉴权。 */
  issueOwnerKey(ownerId: string): string;
  /** 让同一个 owner key 同时可用于 runtimeInstance 端点鉴权。 */
  issueRuntimeInstanceKey(
    runtimeInstanceId: string,
    ownerId: string
  ): string;
  /** 撤销 owner 的 key（容器实例销毁时调用）。 */
  revokeOwner(ownerId: string): void;
}
