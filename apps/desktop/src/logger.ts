import log from "electron-log/main";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export { log };

export function initDesktopLogger(desktopLogsDir: string): typeof log {
  log.transports.file.resolvePathFn = () => join(desktopLogsDir, "main.log");
  log.transports.file.maxSize = 5 * 1024 * 1024;
  log.errorHandler.startCatching();
  log.eventLogger.startLogging();
  return log;
}

export function cleanOldLogs(logDir: string, maxAgeDays = 7): void {
  try {
    if (!existsSync(logDir)) return;
    const now = Date.now();
    for (const file of readdirSync(logDir)) {
      const filePath = join(logDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          cleanOldLogs(filePath, maxAgeDays);
          continue;
        }
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > maxAgeDays * 86_400_000) {
          unlinkSync(filePath);
        }
      } catch {
        // skip files we can't access
      }
    }
  } catch {
    // best-effort
  }
}
