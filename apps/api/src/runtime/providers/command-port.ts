import type {
  CommandPayload,
  RunConfig,
} from "@agework/shared/protocol";

/**
 * Runtime 对外的命令通道抽象：runtime provider 产出命令、登记会话、清理，
 * 但不认识具体实现（HTTP 队列 / IPC / ...）。由 run 层把具体的通信通道
 * 包成此接口注入。Local provider 不使用此 port（直接 IPC send）。
 *
 * runtime 与 worker 通信基础设施无本质关联——本 port 是 runtime 视角下
 * 「命令往哪塞」的中性落点，由 run 负责把 runtime 实例与 worker 通道绑定。
 */
export interface CommandPort {
  /** 建立会话：登记 config、绑定 accessKey、初始化 seq、下发首条 user_message。 */
  openSession(params: {
    runId: string;
    ownerId: string;
    accessKey: string;
    runConfig: RunConfig;
  }): void;
  /** 下发一条命令。 */
  sendCommand(ownerId: string, runId: string, command: CommandPayload): void;
  /** 单个 run 终态：清该 run 的 config + access。 */
  cleanupRun(runId: string): void;
  /** 整个 owner 实例没了：清队列分区 + seq。 */
  cleanupByOwnerId(ownerId: string): void;
}
