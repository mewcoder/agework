import { Logger } from "@nestjs/common";

/** Runtime Host 内建 provider 的日志辅助函数。
 * Promise.catch 处理函数:吞掉错误但以 debug 级别记录 label + 错误信息,
 * 避免完全静默吞错导致排障困难。
 */
export function swallow(logger: Logger, label: string): (err: unknown) => void {
  return (err: unknown) => {
    logger.debug(
      `${label}: ${err instanceof Error ? err.message : String(err)}`
    );
  };
}

/** 把任意字符串收敛成可安全用于容器名/文件名的片段。 */
/** 结构化日志的安全序列化:失败时退回 String()。 */
export function safeLogJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
