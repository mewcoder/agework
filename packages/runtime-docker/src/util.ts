import { Logger } from "@nestjs/common";

export function swallow(logger: Logger, label: string): (err: unknown) => void {
  return (err: unknown) => {
    logger.debug(
      `${label}: ${err instanceof Error ? err.message : String(err)}`
    );
  };
}
