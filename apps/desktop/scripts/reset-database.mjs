import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..", "..");
const userDataRoot = getUserDataRoot();
const dbPath = join(userDataRoot, "agework.db");

assertSafeResetPath(userDataRoot);

console.log(`Resetting desktop user data: ${userDataRoot}`);
console.log("Close AgeWork desktop before running this command.");

if (existsSync(userDataRoot)) {
  rmSync(userDataRoot, { force: true, recursive: true });
}
mkdirSync(userDataRoot, { recursive: true });

console.log(`Creating fresh desktop database: ${dbPath}`);
execFileSync(
  "pnpm",
  ["--filter", "api", "exec", "prisma", "db", "push", "--force-reset"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGEWORK_PRIVATE_DATABASE_URL: `file:${dbPath}`,
    },
    stdio: "inherit",
  }
);
console.log("Desktop reset complete.");

function getUserDataRoot() {
  const override = process.env.AGEWORK_DESKTOP_USER_DATA_DIR?.trim();
  if (override) return resolve(override);

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "@agework", "desktop");
  }

  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "@agework",
      "desktop"
    );
  }

  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "@agework", "desktop");
}

function assertSafeResetPath(targetPath) {
  const resolved = resolve(targetPath);
  const home = resolve(homedir());
  if (resolved === home || resolved === dirname(home) || resolved === resolve("/")) {
    throw new Error(`Refusing to reset unsafe path: ${resolved}`);
  }

  if (process.env.AGEWORK_DESKTOP_USER_DATA_DIR?.trim()) return;

  const expectedSuffix = join("@agework", "desktop");
  if (!resolved.endsWith(expectedSuffix)) {
    throw new Error(`Refusing to reset unexpected desktop user data path: ${resolved}`);
  }
}
