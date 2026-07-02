import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getResourcePaths } from "./resource-paths";

describe("getResourcePaths", () => {
  it("resolves paths against the repo when not packaged", () => {
    const repoRoot = "/repo";
    const paths = getResourcePaths({
      isPackaged: false,
      resourcesPath: "/unused",
      repoRoot,
    });

    expect(paths.serverCwd).toBe(join(repoRoot, "apps", "server"));
    expect(paths.serverMainPath).toBe(
      join(repoRoot, "apps", "server", "dist", "src", "main.js")
    );
    expect(paths.templateDbPath).toBe(
      join(repoRoot, "apps", "desktop", "resources", "template.db")
    );
    expect(paths.claudeCliPath).toBeUndefined();
    expect(paths.codexCliPath).toBeUndefined();
    expect(paths.backendExecPath).toBe("node");
  });

  it("resolves paths under resourcesPath/app when packaged (macOS)", () => {
    const resourcesPath = "/Applications/AgeWork.app/Contents/Resources";
    const paths = getResourcePaths({
      isPackaged: true,
      resourcesPath,
      repoRoot: "/unused",
      platform: "darwin",
    });

    expect(paths.serverCwd).toBe(join(resourcesPath, "app", "server"));
    expect(paths.serverMainPath).toBe(
      join(resourcesPath, "app", "server", "dist", "src", "main.js")
    );
    expect(paths.templateDbPath).toBe(join(resourcesPath, "template.db"));
    expect(paths.claudeCliPath).toBe(join(resourcesPath, "bin", "claude"));
    expect(paths.codexCliPath).toBe(join(resourcesPath, "bin", "codex"));
    expect(paths.backendExecPath).toBeUndefined();
  });

  it("appends .exe to CLI paths when packaged on Windows", () => {
    const resourcesPath = "C:\\Users\\user\\AppData\\Local\\Programs\\AgeWork\\resources";
    const paths = getResourcePaths({
      isPackaged: true,
      resourcesPath,
      repoRoot: "/unused",
      platform: "win32",
    });

    expect(paths.claudeCliPath).toBe(join(resourcesPath, "bin", "claude.exe"));
    expect(paths.codexCliPath).toBe(join(resourcesPath, "bin", "codex.exe"));
    expect(paths.backendExecPath).toBeUndefined();
  });
});
