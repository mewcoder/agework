import { Logger } from "@nestjs/common";

/**
 * 返回一个 Promise.catch 处理函数：吞掉错误但以 debug 级别记录 label 和错误信息，
 * 避免完全静默吞错导致排障困难。
 */
export function swallow(logger: Logger, label: string): (err: unknown) => void {
  return (err: unknown) => {
    logger.debug(
      `${label}: ${err instanceof Error ? err.message : String(err)}`
    );
  };
}
