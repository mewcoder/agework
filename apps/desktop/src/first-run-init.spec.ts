import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUserData } from "./first-run-init";
import { getUserDataPaths } from "./user-data-paths";

describe("ensureUserData", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const userDataRoot = mkdtempSync(join(tmpdir(), "agework-desktop-userdata-"));
    const templateDb = mkdtempSync(join(tmpdir(), "agework-desktop-template-"));
    dirs.push(userDataRoot, templateDb);
    const templateDbPath = join(templateDb, "template.db");
    writeFileSync(templateDbPath, "TEMPLATE-DB-CONTENT");
    return { userDataRoot, templateDbPath };
  }

  it("creates workspace/log dirs and copies the template db on first run", () => {
    const { userDataRoot, templateDbPath } = setup();
    const userData = getUserDataPaths(userDataRoot);

    ensureUserData(userData, { templateDbPath });

    expect(existsSync(userData.workspaceDir)).toBe(true);
    expect(existsSync(userData.logsDir)).toBe(true);
    expect(existsSync(userData.desktopLogsDir)).toBe(true);
    expect(existsSync(userData.apiLogsDir)).toBe(true);
    expect(readFileSync(userData.dbPath, "utf8")).toBe("TEMPLATE-DB-CONTENT");
  });

  it("does not overwrite an existing database on subsequent runs", () => {
    const { userDataRoot, templateDbPath } = setup();
    const userData = getUserDataPaths(userDataRoot);

    ensureUserData(userData, { templateDbPath });
    writeFileSync(userData.dbPath, "USER-DATA");
    ensureUserData(userData, { templateDbPath });

    expect(readFileSync(userData.dbPath, "utf8")).toBe("USER-DATA");
  });
});
