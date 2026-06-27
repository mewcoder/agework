import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import {
  ensureWorkerImage,
  pullRuntimeImages,
  composeUp,
  waitForHealth,
} from "./opensandbox.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiEnv = resolve(repoRoot, "apps/api/.env");
const apiEnvExample = resolve(repoRoot, "apps/api/.env.example");
const webEnv = resolve(repoRoot, "apps/web/.env");
const webEnvExample = resolve(repoRoot, "apps/web/.env.example");
const pnpm = "pnpm";
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");

function parseArgs(args) {
  const options = {
    appName: undefined,
    apiPort: undefined,
    runtimeTypes: undefined,
    isolationScopes: undefined,
    sandboxEngine: undefined,
    ctxPath: undefined,
    isProd: false,
    isDev: false,
    shouldInstall: true,
    noAuth: undefined,
    shouldReset: undefined,
    shouldStart: undefined,
    shouldShowHelp: args.includes("--help") || args.includes("-h"),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      continue;
    }

    if (arg === "--dev") {
      options.isDev = true;
      continue;
    }

    if (arg === "--prod") {
      options.isProd = true;
      continue;
    }

    if (arg === "--no-auth") {
      options.noAuth = true;
      continue;
    }

    if (arg === "--start") {
      options.shouldStart = true;
      continue;
    }

    if (arg === "--reset") {
      options.shouldReset = true;
      continue;
    }

    if (arg === "--no-install") {
      options.shouldInstall = false;
      continue;
    }

    if (arg === "--name") {
      options.appName = normalizeAppName(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--name=")) {
      options.appName = normalizeAppName(arg.slice("--name=".length));
      continue;
    }

    if (arg === "--port") {
      options.apiPort = normalizePort(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      options.apiPort = normalizePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--runtime") {
      options.runtimeTypes = normalizeRuntimeTypes(
        readOptionValue(args, index, arg)
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--runtime=")) {
      options.runtimeTypes = normalizeRuntimeTypes(
        arg.slice("--runtime=".length)
      );
      continue;
    }

    if (arg === "--isolation") {
      options.isolationScopes = normalizeIsolationScopes(
        readOptionValue(args, index, arg)
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--isolation=")) {
      options.isolationScopes = normalizeIsolationScopes(
        arg.slice("--isolation=".length)
      );
      continue;
    }

    if (arg === "--sandbox-engine") {
      options.sandboxEngine = normalizeSandboxEngine(
        readOptionValue(args, index, arg)
      );
      index += 1;
      continue;
    }

    if (arg.startsWith("--sandbox-engine=")) {
      options.sandboxEngine = normalizeSandboxEngine(
        arg.slice("--sandbox-engine=".length)
      );
      continue;
    }

    if (arg === "--ctx") {
      options.ctxPath = normalizeCtxPath(readOptionValue(args, index, arg));
      index += 1;
      continue;
    }

    if (arg.startsWith("--ctx=")) {
      options.ctxPath = normalizeCtxPath(arg.slice("--ctx=".length));
      continue;
    }

    throw new Error(`Unknown init argument: ${arg}`);
  }

  return options;
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value after ${optionName}`);
  }
  return value;
}

function normalizeAppName(rawValue) {
  const value = rawValue.trim();

  if (!value) {
    throw new Error("--name must not be empty");
  }

  if (/[\r\n]/.test(value)) {
    throw new Error("--name must be a single line");
  }

  return value;
}

function normalizePort(rawValue) {
  const value = rawValue.trim();

  if (!/^\d+$/.test(value)) {
    throw new Error("--port expects a number between 1 and 65535");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port expects a number between 1 and 65535");
  }

  return String(port);
}

function normalizeRuntimeTypes(rawValue) {
  const values = rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (
    values.length === 0 ||
    values.some((value) => value !== "local" && value !== "sandbox")
  ) {
    throw new Error("--runtime expects \"local\", \"sandbox\" or \"local,sandbox\"");
  }

  return [...new Set(values)].join(",");
}

function normalizeIsolationScopes(rawValue) {
  const values = rawValue
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (
    values.length === 0 ||
    values.some((value) => value !== "user" && value !== "workspace")
  ) {
    throw new Error(
      "--isolation expects \"user\", \"workspace\" or \"user,workspace\""
    );
  }

  return [...new Set(values)].join(",");
}

function normalizeSandboxEngine(rawValue) {
  const value = rawValue.trim().toLowerCase();

  if (value !== "docker" && value !== "opensandbox") {
    throw new Error("--sandbox-engine expects \"docker\" or \"opensandbox\"");
  }

  return value;
}

function normalizeCtxPath(rawValue) {
  const value = rawValue.trim();

  if (/^[a-z][a-z\d+\-.]*:/i.test(value) || value.startsWith("//")) {
    throw new Error("--ctx expects a path like /agent, not a full URL");
  }

  if (/[?#\s]/.test(value)) {
    throw new Error("--ctx must not contain spaces, ? or #");
  }

  return normalizePath(value) || "/";
}

function normalizePath(value) {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "." || trimmed === "./" || /^\/+$/.test(trimmed)) {
    return "";
  }

  const normalized = trimmed
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "";
}

function ensureEnv(envPath, examplePath, label, options = {}) {
  if (existsSync(envPath) && !options.reset) {
    console.log(`${label} already exists`);
    return false;
  }

  if (!existsSync(examplePath)) {
    throw new Error(`Missing ${label}.example`);
  }

  copyFileSync(examplePath, envPath);
  console.log(
    `${options.reset ? "Reset" : "Created"} ${label} from ${label}.example`
  );
  return true;
}

function readEnvValues(envPath) {
  const values = new Map();
  const content = readFileSync(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (match) values.set(match[1], match[2].trim());
  }

  return values;
}

function getApiPort() {
  if (!existsSync(apiEnv)) return "3000";
  return readEnvValues(apiEnv).get("PORT") ?? "3000";
}

function formatEnvValue(value) {
  if (!/[\s#"'\\]/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function generateJwtSecret() {
  return randomBytes(32).toString("base64url");
}

function getDbPath() {
  const apiDir = resolve(repoRoot, "apps/api");
  const dbUrl = existsSync(apiEnv)
    ? (readEnvValues(apiEnv).get("AGEWORK_PRIVATE_DATABASE_URL") ?? "file:./dev.db")
    : "file:./dev.db";
  return resolve(apiDir, dbUrl.replace(/^file:/, ""));
}

async function getDbTablesWithData() {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) return [];
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name`
  ).all().map((r) => r.name);
  const result = tables.filter((t) => {
    const row = db.prepare(`SELECT COUNT(*) as n FROM "${t}"`).get();
    return row.n > 0;
  });
  db.close();
  return result;
}

async function backupDb(tableNames) {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) return {};
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  const backups = {};
  for (const table of tableNames) {
    try {
      backups[table] = db.prepare(`SELECT * FROM "${table}"`).all();
      console.log(`  备份 ${table}: ${backups[table].length} 条`);
    } catch {
      backups[table] = [];
    }
  }
  db.close();
  return backups;
}

async function restoreDb(backups) {
  const dbPath = getDbPath();
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  for (const [table, rows] of Object.entries(backups)) {
    if (rows.length === 0) continue;
    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => `"${c}"`).join(", ");
    const placeholders = cols.map((c) => `@${c}`).join(", ");
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO "${table}" (${colList}) VALUES (${placeholders})`
    );
    db.transaction((rows) => { for (const row of rows) stmt.run(row); })(rows);
    console.log(`  恢复 ${table}: ${rows.length} 条`);
  }
  db.close();
}

function apiModeDefaults(noAuth) {
  return {
    AGEWORK_PRIVATE_JWT_SECRET: generateJwtSecret(),
    AGEWORK_PRIVATE_ADMIN_INIT_KEY: generateJwtSecret(),
    AGEWORK_DEV_AUTH_DISABLED: noAuth ? "true" : "false",
  };
}

async function promptYesNo(question, defaultYes) {
  const result = await p.confirm({ message: question, initialValue: defaultYes });
  if (p.isCancel(result)) process.exit(0);
  return result;
}

function applyEnvDefaults(envPath, defaults, label, options = {}) {
  const envValues = readEnvValues(envPath);
  const updates = {};

  for (const [key, value] of Object.entries(defaults)) {
    if (options.overwrite || !envValues.has(key)) {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length > 0) {
    upsertEnvValues(envPath, updates, label);
  }
}

function syncMissingEnvKeys(envPath, examplePath, label) {
  const exampleValues = readEnvValues(examplePath);
  const envValues = readEnvValues(envPath);
  const missingEntries = [...exampleValues.entries()].filter(
    ([key]) => !envValues.has(key)
  );

  if (missingEntries.length === 0) return;

  const current = readFileSync(envPath, "utf8");
  const prefix = current.endsWith("\n") ? "" : "\n";
  const lines = [
    "",
    "# Added by init script from .env.example",
    ...missingEntries.map(([key, value]) => `${key}=${value}`),
  ];
  writeFileSync(envPath, `${current}${prefix}${lines.join("\n")}\n`);
  console.log(
    `${label} added missing env keys: ${missingEntries
      .map(([key]) => key)
      .join(", ")}`
  );
}

function upsertEnvValues(envPath, values, label) {
  let content = readFileSync(envPath, "utf8");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const updatedKeys = [];

  for (const [key, value] of Object.entries(values)) {
    const linePattern = new RegExp(`^\\s*${key}\\s*=`);
    const nextLine = `${key}=${formatEnvValue(value)}`;
    const index = lines.findIndex((line) => linePattern.test(line));

    if (index >= 0) {
      if (lines[index] !== nextLine) {
        lines[index] = nextLine;
        updatedKeys.push(key);
      }
    } else {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(nextLine);
      updatedKeys.push(key);
    }
  }

  if (updatedKeys.length === 0) return;

  content = lines.join(lineEnding).replace(/\s*$/, lineEnding);
  writeFileSync(envPath, content);
  console.log(`${label} updated env keys: ${updatedKeys.join(", ")}`);
}

function runPnpm(args, env) {
  console.log(`pnpm ${args.join(" ")}`);

  const result = spawnSync(pnpm, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runNode(args) {
  console.log(`node ${args.join(" ")}`);

  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function findListeningPids(port) {
  if (process.platform === "win32") {
    const result = spawnSync("netstat", ["-ano"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) return [];

    return [
      ...new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.includes("LISTENING"))
          .map((line) => line.split(/\s+/))
          .filter((columns) => columns[1]?.endsWith(`:${port}`))
          .map((columns) => columns.at(-1))
          .filter(Boolean)
      ),
    ];
  }

  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    {
      encoding: "utf8",
      stdio: "pipe",
    }
  );
  if (result.status !== 0) return [];

  return [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))];
}

async function ensureDevPortAvailable(interactive) {
  const port = getApiPort();
  const pids = findListeningPids(port);
  if (pids.length === 0) return true;

  const pidList = pids.join(", ");
  if (!interactive) {
    console.error(
      `端口 ${port} 已被进程 ${pidList} 占用。请先运行 pnpm kill-port ${port} 后再启动 dev。`
    );
    return false;
  }

  const shouldKill = await promptYesNo(
    `端口 ${port} 已被进程 ${pidList} 占用，是否执行 pnpm kill-port ${port}？`,
    true
  );
  if (!shouldKill) {
    console.log("已跳过启动 dev 服务。");
    return false;
  }

  runPnpm(["kill-port", port]);
  if (findListeningPids(port).length > 0) {
    console.error(`端口 ${port} 仍被占用，已跳过启动 dev 服务。`);
    return false;
  }
  return true;
}

async function startDev(interactive) {
  if (await ensureDevPortAvailable(interactive)) {
    runPnpm(["dev"]);
  }
}

async function main() {
  let {
    appName,
    apiPort,
    runtimeTypes,
    isolationScopes,
    sandboxEngine,
    ctxPath,
    isProd,
    isDev,
    shouldInstall,
    noAuth,
    shouldReset,
    shouldStart,
    shouldShowHelp,
  } = parseArgs(rawArgs);

  if (shouldShowHelp) {
    console.log("Usage:");
    console.log("  pnpm boot             Interactive mode");
    console.log("  pnpm init:dev         Dev defaults (no-auth=true, no prompts)");
    console.log("  pnpm init:prod        Prod defaults (no-auth=false, no prompts)");
    console.log("Options:");
    console.log("  --no-auth        Disable authentication (sets AGEWORK_DEV_AUTH_DISABLED=true)");
    console.log("  --reset          Reset .env defaults and recreate database data");
    console.log("  --start          Start dev server after init");
    console.log("  --ctx <path>     Set backend context and frontend paths, for example /agent");
    console.log("  --name <name>    Set AGEWORK_APP_NAME in apps/api/.env");
    console.log("  --port <port>    Set backend PORT in apps/api/.env");
    console.log("  --runtime <local|sandbox|local,sandbox>  Set AGEWORK_RUNTIME_ALLOWED_TYPES in apps/api/.env");
    console.log("  --isolation <user|workspace|user,workspace>  Set AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES in apps/api/.env");
    console.log("  --sandbox-engine <docker|opensandbox>     Set AGEWORK_SANDBOX_ENGINE in apps/api/.env");
    console.log("  --no-install     Skip pnpm install");
    console.log("Default: runs pnpm install unless --no-install is set.");
    return;
  }

  const interactive = !isDev && !isProd;
  if (interactive) p.intro("AgeWork 初始化");
  if (noAuth === undefined) {
    noAuth = interactive ? !(await promptYesNo("启用登录验证？", false)) : !isProd;
  }
  if (shouldReset === undefined) {
    shouldReset = interactive ? await promptYesNo("重置数据库？", false) : false;
  }
  let backupTables = [];
  if (interactive && shouldReset) {
    const tables = await getDbTablesWithData();
    if (tables.length > 0) {
      const shouldBackup = await promptYesNo("备份数据？", true);
      if (shouldBackup) {
        const result = await p.multiselect({
          message: "选择要备份的表",
          options: tables.map((t) => ({ value: t, label: t })),
          required: false,
          initialValues: tables.filter((t) => t === "ModelProvider"),
        });
        if (!p.isCancel(result)) backupTables = result;
      }
    }
  }
  if (runtimeTypes === undefined && interactive) {
    const result = await p.select({
      message: "允许的工作空间运行环境",
      options: [
        { value: "local", label: "local（只允许本机进程）" },
        { value: "sandbox", label: "sandbox（只允许沙箱）" },
        { value: "local,sandbox", label: "local,sandbox（创建工作空间时可选）" },
      ],
      initialValue: "local",
    });
    if (p.isCancel(result)) process.exit(0);
    runtimeTypes = result;
  }
  const allowsSandbox = runtimeTypes?.split(",").includes("sandbox") ?? false;
  if (allowsSandbox && isolationScopes === undefined && interactive) {
    const result = await p.select({
      message: "允许的沙箱隔离级别",
      options: [
        { value: "user", label: "user（同一用户共享一个沙箱资源）" },
        { value: "workspace", label: "workspace（每个工作空间独立沙箱资源）" },
        { value: "user,workspace", label: "user,workspace（创建工作空间时可选）" },
      ],
      initialValue: "user",
    });
    if (p.isCancel(result)) process.exit(0);
    isolationScopes = result;
  }
  if (allowsSandbox && sandboxEngine === undefined && interactive) {
    const result = await p.select({
      message: "Sandbox 引擎",
      options: [
        { value: "docker", label: "docker（本机 Docker 容器）" },
        { value: "opensandbox", label: "opensandbox（OpenSandbox Server + worker 镜像）" },
      ],
      initialValue: "docker",
    });
    if (p.isCancel(result)) process.exit(0);
    sandboxEngine = result;
  }
  if (shouldInstall) runPnpm(["install"]);
  const apiWasCreated = ensureEnv(apiEnv, apiEnvExample, "apps/api/.env", {
    reset: shouldReset,
  });
  ensureEnv(webEnv, webEnvExample, "apps/web/.env", {
    reset: shouldReset,
  });
  applyEnvDefaults(apiEnv, apiModeDefaults(noAuth), "apps/api/.env", {
    overwrite: shouldReset || apiWasCreated,
  });
  if (interactive || rawArgs.includes("--no-auth")) {
    upsertEnvValues(
      apiEnv,
      { AGEWORK_DEV_AUTH_DISABLED: noAuth ? "true" : "false" },
      "apps/api/.env"
    );
  }
  syncMissingEnvKeys(apiEnv, apiEnvExample, "apps/api/.env");
  syncMissingEnvKeys(webEnv, webEnvExample, "apps/web/.env");
  const apiUpdates = {};
  if (appName) apiUpdates.AGEWORK_APP_NAME = appName;
  if (apiPort) apiUpdates.PORT = apiPort;
  if (runtimeTypes) apiUpdates.AGEWORK_RUNTIME_ALLOWED_TYPES = runtimeTypes;
  if (isolationScopes) {
    apiUpdates.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES = isolationScopes;
  }
  if (sandboxEngine) apiUpdates.AGEWORK_SANDBOX_ENGINE = sandboxEngine;
  // Docker / OpenSandbox 都依赖同一个 worker 镜像。
  if (allowsSandbox) {
    await ensureWorkerImage({ interactive, shouldReset, promptYesNo });
  }
  if (allowsSandbox && sandboxEngine === "opensandbox") {
    console.log("🚀 启动 OpenSandbox Server...");
    pullRuntimeImages();
    composeUp();
    await waitForHealth();
  }
  if (ctxPath) {
    apiUpdates.AGEWORK_CONTEXT = ctxPath;
    upsertEnvValues(
      webEnv,
      {
        VITE_APP_BASE_PATH: ctxPath,
        VITE_APP_API_CONTEXT: ctxPath,
      },
      "apps/web/.env"
    );
  }
  if (Object.keys(apiUpdates).length > 0) {
    upsertEnvValues(apiEnv, apiUpdates, "apps/api/.env");
  }
  runNode(["scripts/check-env.mjs", ...(isProd ? ["--prod"] : [])]);
  runPnpm(["--filter", "api", "db:generate"]);
  if (shouldReset) {
    let backups = {};
    if (backupTables.length > 0) {
      console.log("📦 备份数据...");
      backups = await backupDb(backupTables);
    }
    runPnpm(["--filter", "api", "db:reset"]);
    if (backupTables.length > 0) {
      console.log("♻️  恢复数据...");
      await restoreDb(backups);
    }
  } else {
    runPnpm(["--filter", "api", "db:push"]);
  }
  if (interactive) {
    const run = await p.select({
      message: "启动服务",
      options: [
        { value: "dev", label: "开发模式" },
        { value: "api-web", label: "启动后端 + 前端" },
        { value: "api", label: "启动后端" },
        { value: "build", label: "仅构建" },
        { value: "none", label: "跳过" },
      ],
    });
    if (p.isCancel(run)) process.exit(0);
    if (run === "dev") await startDev(interactive);
    else if (run === "build") runPnpm(["build"]);
    else if (run === "api") {
      runPnpm(["build"]);
      runPnpm(["start:api"]);
    } else if (run === "api-web") {
      runPnpm(["build"]);
      runPnpm(["start"]);
    }
    if (interactive) p.outro("完成");
  } else if (shouldStart) {
    await startDev(interactive);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
