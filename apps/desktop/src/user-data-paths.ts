import { join } from "node:path";

export type UserDataPaths = {
  root: string;
  dbPath: string;
  databaseUrl: string;
  workspaceDir: string;
  logsDir: string;
  desktopLogsDir: string;
  apiLogsDir: string;
  windowStateFile: string;
};

/** Derives all on-disk locations the desktop app needs from Electron's userData dir. */
export function getUserDataPaths(userDataRoot: string): UserDataPaths {
  const dbPath = join(userDataRoot, "agework.db");
  const logsDir = join(userDataRoot, "logs");
  return {
    root: userDataRoot,
    dbPath,
    databaseUrl: `file:${dbPath}`,
    workspaceDir: join(userDataRoot, "workspaces"),
    logsDir,
    desktopLogsDir: join(logsDir, "desktop"),
    apiLogsDir: join(logsDir, "api"),
    windowStateFile: join(userDataRoot, "window-state.json"),
  };
}
