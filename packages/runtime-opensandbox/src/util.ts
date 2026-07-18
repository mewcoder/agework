import { Logger } from "@nestjs/common";

/** 记录并吞掉 best-effort 资源清理错误。 */
export function swallow(logger: Logger, label: string): (err: unknown) => void {
  return (err: unknown) => {
    logger.debug(
      `${label}: ${err instanceof Error ? err.message : String(err)}`
    );
  };
}
