import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getUserDataPaths } from "./user-data-paths";

describe("getUserDataPaths", () => {
  it("derives all paths from the given userData root", () => {
    const root = "/Users/test/Library/Application Support/AgeWork";
    const paths = getUserDataPaths(root);

    expect(paths.root).toBe(root);
    expect(paths.dbPath).toBe(join(root, "agework.db"));
    expect(paths.databaseUrl).toBe(`file:${join(root, "agework.db")}`);
    expect(paths.workspaceDir).toBe(join(root, "workspaces"));
    expect(paths.logsDir).toBe(join(root, "logs"));
    expect(paths.desktopLogsDir).toBe(join(root, "logs", "desktop"));
    expect(paths.apiLogsDir).toBe(join(root, "logs", "api"));
    expect(paths.windowStateFile).toBe(join(root, "window-state.json"));
  });
});
