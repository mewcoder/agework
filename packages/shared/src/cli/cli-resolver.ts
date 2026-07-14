/**
 * Agent CLI 环境检测（纯 child_process + fs，无运行时依赖）。
 *
 * 供 server builtin Host 进程内检测、apps/runtime（Host 注册时
 * 上报）、packages/worker（run 执行时 fallback）共用同一份 PATH 查找 + 已知位置搜索 +
 * 版本解析逻辑。提取自原 apps/server 与 apps/runtime 各自的 cli-resolver 副本，
 * 消除"改一份忘一份"（Windows npm shim .cmd 检测 bug 即因此暴露）。
 *
 * Windows 兼容要点：
 * - `findInPath`：`where name.exe` 优先找 native binary，再回退 npm shim (.cmd/.bat)。
 *   codex/claude 在 Windows 上常通过 `npm i -g` 安装，只产出 .cmd shim 而无 .exe，
 *   必须回退 .cmd 否则检测必然落空。
 * - `getVersion`：npm shim (.cmd/.bat) 有两个坑——`spawnSync(path, args, {shell:true})`
 *   调 .cmd 时 stdout 为空（shim 的 `@ECHO off` + `GOTO` 结构导致）；
 *   `spawnSync('cmd', ['/c', path, ...])` 直接传 .cmd 完整路径同样拿不到 stdout。
 *   解法：把 .cmd 所在目录加进子进程 PATH、用 `cmd /c <basename>` 让 cmd 按 PATHEXT
 *   解析，能正常拿到 stdout。不硬编码任何路径，纯靠 executablePath 自身的 dirname/basename。
 *   非 shim 路径(.exe / Unix 二进制)直接 spawn 且**不带 shell**——shell:true 不给
 *   带空格的路径(Program Files、用户名带空格)加引号,必然失败;JS 入口(cli.js
 *   已知位置)不是可执行文件,用 `node <path>` 执行。
 *
 * 注意：本文件是 shared 包 `./cli` 入口，所有运行时值（函数、常量）必须内联在本文件中，
 * 不可跨文件 re-export——shared 包以源码形式被消费（exports 指向 src 源文件，无 dist），
 * NodeNext 运行时解析跨文件 re-export 需要显式扩展名，而磁盘上是 .ts，会导致
 * ERR_MODULE_NOT_FOUND。类型可以用 `import type` 从其他文件引入（编译期擦除）。
 */

import { spawn, spawnSync, execSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type {
  AgentType,
  AgentDetectedEnv,
  RuntimeEnvConfig,
} from "../common";

/**
 * 检测本机 agent CLI 环境，返回完整的 envConfig（claude + codex）。
 * builtin Host 启动时、registered Host 注册时、admin 触发重检时各调一次。
 */
export function detectEnvConfig(): RuntimeEnvConfig {
  return {
    claude: detectAgent("claude"),
    codex: detectAgent("codex"),
    opencode: detectAgent("opencode"),
    detectedAt: new Date().toISOString(),
  };
}

function detectAgent(agentType: AgentType): AgentDetectedEnv {
  const executablePath = resolveCliPath(agentType);
  const version = executablePath ? getVersion(executablePath) : null;
  return { executablePath, version };
}

/** PATH 查找 + 已知位置搜索，返回第一个找到的路径。 */
function resolveCliPath(agentType: AgentType): string | null {
  // 1. PATH 查找（which / where）
  const pathResult = findInPath(agentType);
  if (pathResult) return pathResult;

  // 2. 已知位置搜索
  const known =
    agentType === "claude"
      ? claudeKnownLocations()
      : agentType === "codex"
        ? codexKnownLocations()
        : opencodeKnownLocations();
  return known[0] ?? null;
}

/** PATH 查找。Windows: `.exe` 优先，回退 `.cmd`/`.bat`（npm shim）。Unix: `which`。 */
export function findInPath(name: string): string | null {
  // Windows: `where` 优先找 native binary (.exe)，再回退 npm shim (.cmd/.bat)。
  // codex/claude 在 Windows 上常通过 `npm i -g` 安装，只产出 .cmd shim 而无 .exe，
  // 必须回退 .cmd 否则检测必然落空。
  // Unix: `which` 只查可执行文件，无需扩展名回退。
  if (process.platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const found = whereFirst(`${name}${ext}`);
      if (found) return found;
    }
    return null;
  }
  return whichFirst(name);
}

function whereFirst(pattern: string): string | null {
  try {
    const result = execSync(`where ${pattern} 2>nul`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return result.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function whichFirst(name: string): string | null {
  try {
    const result = execSync(`which ${name} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return result.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** 执行 CLI --version，提取纯版本号。失败不阻塞，返回 null。
 *  codex 输出 `codex-cli 0.142.2`，claude 输出 `2.1.201 (Claude Code)`，
 *  统一提取第一段 semver 风格的版本号。
 *
 *  按路径形态分派执行方式(每种都踩过坑,别合并):
 *  - Windows npm shim (.cmd/.bat):见文件头注释,`cmd /c <basename>` +
 *    把 dirname 加进子进程 PATH 才能拿到 stdout;
 *  - JS 入口 (cli.js 等已知位置):不是可执行文件,必须 `node <path> --version`;
 *  - 其余(.exe / Unix 二进制):直接 spawn,**不带 shell**——shell:true 时
 *    带空格的路径(Program Files、用户名带空格)不会被引号包裹,必然失败。 */
export function getVersion(executablePath: string): string | null {
  try {
    const ext = extname(executablePath).toLowerCase();
    const isWindows = process.platform === "win32";
    const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    };

    let result;
    if (isWindows && (ext === ".cmd" || ext === ".bat")) {
      result = spawnSync("cmd", ["/c", basename(executablePath), "--version"], {
        ...spawnOptions,
        env: {
          ...process.env,
          PATH: `${dirname(executablePath)};${process.env.PATH ?? ""}`,
        },
      });
    } else if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      result = spawnSync(
        process.execPath,
        [executablePath, "--version"],
        spawnOptions
      );
    } else {
      result = spawnSync(executablePath, ["--version"], spawnOptions);
    }
    if (result.error || result.status !== 0) return null;
    const raw = result.stdout.trim();
    if (!raw) return null;
    // 提取第一个 x.y.z 格式的版本号
    const match = raw.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : raw;
  } catch {
    return null;
  }
}

// ── 已知安装位置搜索 ──────────────────────────────────────────────

function isExistingFile(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      return statSync(filePath).isFile();
    }
  } catch {
    // Inaccessible path
  }
  return false;
}

/** Claude CLI 已知安装位置（不含 PATH 查找，由调用方先用 which/where 查 PATH）。 */
function claudeKnownLocations(): string[] {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const paths: string[] = [];

  if (isWindows) {
    paths.push(join(home, ".claude", "local", "claude.exe"));
    paths.push(join(home, "AppData", "Local", "Claude", "claude.exe"));
    paths.push(
      join(
        process.env.ProgramFiles || "C:\\Program Files",
        "Claude",
        "claude.exe"
      )
    );
    paths.push(
      join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Claude",
        "claude.exe"
      )
    );
    paths.push(join(home, ".local", "bin", "claude.exe"));
    // npm global（Windows 上 npm 全局安装只产出 .cmd shim，无 .exe）
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", "claude.cmd"));
      paths.push(join(process.env.APPDATA, "npm", "claude.exe"));
      paths.push(
        join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js"
        )
      );
    }
    // chocolatey
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", "claude.exe"));
    // scoop
    paths.push(join(home, "scoop", "shims", "claude.exe"));
    paths.push(join(home, "scoop", "shims", "claude.cmd"));
  }

  // Unix (macOS + Linux)
  paths.push(join(home, ".claude", "local", "claude"));
  paths.push(join(home, ".local", "bin", "claude"));
  paths.push(join(home, ".volta", "bin", "claude"));
  paths.push(join(home, ".asdf", "shims", "claude"));
  paths.push(join(home, ".asdf", "bin", "claude"));
  paths.push("/usr/local/bin/claude");
  paths.push("/opt/homebrew/bin/claude");
  paths.push(join(home, "bin", "claude"));
  paths.push(join(home, ".npm-global", "bin", "claude"));

  // npm global prefix
  if (process.env.npm_config_prefix) {
    paths.push(join(process.env.npm_config_prefix, "bin", "claude"));
  }

  return paths.filter(isExistingFile);
}

/** Codex CLI 已知安装位置。 */
function codexKnownLocations(): string[] {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const paths: string[] = [];

  if (isWindows) {
    paths.push(join(home, ".local", "bin", "codex.exe"));
    paths.push(join(home, ".local", "bin", "codex.cmd"));
    // npm global（Windows 上 npm 全局安装只产出 .cmd shim，无 .exe）
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", "codex.cmd"));
      paths.push(join(process.env.APPDATA, "npm", "codex.exe"));
    }
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", "codex.exe"));
    paths.push(join(home, "scoop", "shims", "codex.exe"));
    paths.push(join(home, "scoop", "shims", "codex.cmd"));
  }

  paths.push(join(home, ".local", "bin", "codex"));
  paths.push(join(home, ".volta", "bin", "codex"));
  paths.push("/usr/local/bin/codex");
  paths.push("/opt/homebrew/bin/codex");
  paths.push(join(home, ".npm-global", "bin", "codex"));

  if (process.env.npm_config_prefix) {
    paths.push(join(process.env.npm_config_prefix, "bin", "codex"));
  }

  return paths.filter(isExistingFile);
}

/** OpenCode CLI 已知安装位置。 */
function opencodeKnownLocations(): string[] {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const paths: string[] = [];

  if (isWindows) {
    paths.push(join(home, ".opencode", "bin", "opencode.exe"));
    paths.push(join(home, ".local", "bin", "opencode.exe"));
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", "opencode.cmd"));
      paths.push(join(process.env.APPDATA, "npm", "opencode.exe"));
    }
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", "opencode.exe"));
    paths.push(join(home, "scoop", "shims", "opencode.exe"));
    paths.push(join(home, "scoop", "shims", "opencode.cmd"));
  }

  // opencode 官方安装脚本默认落到 ~/.opencode/bin。
  paths.push(join(home, ".opencode", "bin", "opencode"));
  paths.push(join(home, ".local", "bin", "opencode"));
  paths.push(join(home, ".volta", "bin", "opencode"));
  paths.push("/usr/local/bin/opencode");
  paths.push("/opt/homebrew/bin/opencode");
  paths.push(join(home, ".npm-global", "bin", "opencode"));

  if (process.env.npm_config_prefix) {
    paths.push(join(process.env.npm_config_prefix, "bin", "opencode"));
  }

  return paths.filter(isExistingFile);
}

/** 返回某个 agent 类型对应的、可通过 npm 安装的独立 CLI 包名
 *  （区别于内嵌调用用的 SDK 包，如 `@anthropic-ai/claude-agent-sdk`）。 */
export function resolveCliPackageName(agentType: AgentType): string {
  switch (agentType) {
    case "claude":
      return "@anthropic-ai/claude-code";
    case "opencode":
      return "opencode-ai";
    case "codex":
    default:
      return "@openai/codex";
  }
}

// ── agent CLI 一键安装 ────────────────────────────────────────────────
//
// 把独立 CLI 包装进 Host 专属目录(per-agent 一个子目录),不走全局
// `npm install -g`,避免跟机器上已有的系统安装冲突。builtin 与 registered
// Host 共用同一实现;安装完成后由 server 把返回路径写成 envConfigOverride。

const NPM_INSTALL_TIMEOUT_MS = 120_000;

/** 把 agentType 对应的独立 CLI 装进 cliRootDir 下的专属目录,返回可执行文件绝对路径。 */
export async function installCli(
  agentType: AgentType,
  cliRootDir: string
): Promise<string> {
  const dir = join(cliRootDir, agentType);
  mkdirSync(dir, { recursive: true });

  await runNpmInstall(dir, resolveCliPackageName(agentType));

  const binPath = resolveInstalledBinPath(cliRootDir, agentType);
  if (!binPath) {
    throw new Error(`安装完成但未找到可执行文件：${agentType}`);
  }
  return binPath;
}

/** 一键安装目录里某 agent CLI 的可执行文件路径;未安装返回 null。 */
export function resolveInstalledBinPath(
  cliRootDir: string,
  agentType: AgentType
): string | null {
  const binName = process.platform === "win32" ? `${agentType}.cmd` : agentType;
  const binPath = join(cliRootDir, agentType, "node_modules", ".bin", binName);
  return existsSync(binPath) ? binPath : null;
}

function runNpmInstall(cwd: string, packageName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      npmCommand,
      ["install", "--prefix", cwd, `${packageName}@latest`],
      { timeout: NPM_INSTALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `npm install 失败（exit ${code}）：${stderr.trim().slice(-500)}`
          )
        );
      }
    });
  });
}
