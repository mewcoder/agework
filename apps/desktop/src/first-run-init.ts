import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import type { ResourcePaths } from "./resource-paths";
import type { UserDataPaths } from "./user-data-paths";

/**
 * Ensures the userData directory is ready to use and copies the empty-schema
 * template database on first run. Never overwrites an existing database.
 */
export function ensureUserData(
  userData: UserDataPaths,
  resources: Pick<ResourcePaths, "templateDbPath">
): void {
  mkdirSync(userData.root, { recursive: true });
  mkdirSync(userData.workspaceDir, { recursive: true });
  mkdirSync(userData.logsDir, { recursive: true });
  mkdirSync(userData.desktopLogsDir, { recursive: true });
  mkdirSync(userData.apiLogsDir, { recursive: true });

  if (!existsSync(userData.dbPath)) {
    copyFileSync(resources.templateDbPath, userData.dbPath);
  }
}
