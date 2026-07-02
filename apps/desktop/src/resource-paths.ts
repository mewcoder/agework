import { join } from "node:path";

export type ResourcePaths = {
  /** cwd to fork the NestJS backend from so `../web/dist` resolves correctly. */
  serverCwd: string;
  /** Absolute path to the compiled NestJS entry point. */
  serverMainPath: string;
  /** Pre-built empty SQLite db copied into userData on first run. */
  templateDbPath: string;
  /** Bundled claude CLI binary, packaged builds only. */
  claudeCliPath?: string;
  /** Bundled codex CLI binary, packaged builds only. */
  codexCliPath?: string;
  /** Backend executable override. Dev uses system Node; packaged uses Electron. */
  backendExecPath?: string;
};

export type ResourcePathsOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  /** Defaults to process.platform. Exposed for testing. */
  platform?: NodeJS.Platform;
};

/**
 * Resolves filesystem locations for the backend, frontend, template database,
 * and Agent CLI binaries.
 */
export function getResourcePaths(options: ResourcePathsOptions): ResourcePaths {
  const { isPackaged, resourcesPath, repoRoot, platform = process.platform } = options;

  if (isPackaged) {
    const appDir = join(resourcesPath, "app");
    const exe = platform === "win32" ? ".exe" : "";
    return {
      serverCwd: join(appDir, "server"),
      serverMainPath: join(appDir, "server", "dist", "src", "main.js"),
      templateDbPath: join(resourcesPath, "template.db"),
      claudeCliPath: join(resourcesPath, "bin", `claude${exe}`),
      codexCliPath: join(resourcesPath, "bin", `codex${exe}`),
    };
  }

  return {
    serverCwd: join(repoRoot, "apps", "server"),
    serverMainPath: join(repoRoot, "apps", "server", "dist", "src", "main.js"),
    templateDbPath: join(repoRoot, "apps", "desktop", "resources", "template.db"),
    backendExecPath: process.env.AGEWORK_DESKTOP_NODE_PATH?.trim() || "node",
  };
}
