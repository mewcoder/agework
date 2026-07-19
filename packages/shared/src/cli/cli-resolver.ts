/**
 * Agent CLI 环境检测（纯 child_process + fs，无运行时依赖）。
 *
 * 供 server builtin Host 进程内检测、apps/runtime（Host 注册时
 * 上报）、Runtime Worker（run 执行时 fallback）共用同一份 PATH 查找 + 已知位置搜索 +
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
    pi: detectAgent("pi"),
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

  // 2. 已知位置搜索（agent 特有位置优先,通用安装位置兜底）
  return knownLocations(agentType)[0] ?? null;
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

// ── Agent CLI 目录表 ──────────────────────────────────────────────
//
// 预定义闭集:每个 agent 的可安装包名 / 伴生包 / 特有安装位置在此登记一行,
// 不开放用户自填命令。通用安装位置(npm 全局、homebrew、volta、scoop 等)由
// commonKnownLocations 统一探测,表里只写该 agent 独有的路径。

type AgentCliSpec = {
  /** 可通过 npm 安装的独立 CLI 包名(区别于内嵌调用用的 SDK 包)。 */
  npmPackage: string;
  /** 必须与主包装进同一 prefix 的伴生包(如 ACP 桥,bin 落同一目录)。 */
  companionPackages?: readonly string[];
  /** 该 agent 特有的安装位置(优先于通用位置探测)。 */
  extraKnownLocations?: () => string[];
};

const AGENT_CLI_SPECS: Record<AgentType, AgentCliSpec> = {
  claude: {
    npmPackage: "@anthropic-ai/claude-code",
    extraKnownLocations: () => {
      const home = homedir();
      const paths: string[] = [];
      if (process.platform === "win32") {
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
        // npm 全局安装的 JS 入口(无 .exe 时经 `node cli.js` 执行)
        if (process.env.APPDATA) {
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
      }
      paths.push(join(home, ".claude", "local", "claude"));
      paths.push(join(home, ".asdf", "shims", "claude"));
      paths.push(join(home, ".asdf", "bin", "claude"));
      paths.push(join(home, "bin", "claude"));
      return paths;
    },
  },
  codex: {
    npmPackage: "@openai/codex",
  },
  opencode: {
    npmPackage: "opencode-ai",
    // opencode 官方安装脚本默认落到 ~/.opencode/bin。
    extraKnownLocations: () => {
      const home = homedir();
      const paths = [join(home, ".opencode", "bin", "opencode")];
      if (process.platform === "win32") {
        paths.unshift(join(home, ".opencode", "bin", "opencode.exe"));
      }
      return paths;
    },
  },
  pi: {
    // pi 本体不会说 ACP,经 pi-acp 桥(ACP ⇄ `pi --mode rpc`)接入:
    // 一键安装需把桥包装进同一 prefix(bin 同目录,worker 按 pi 路径的兄弟文件解析)。
    npmPackage: "@earendil-works/pi-coding-agent",
    companionPackages: ["pi-acp"],
    // bun 全局安装(官方也推荐 npm -g,通用位置已覆盖)。
    extraKnownLocations: () => [join(homedir(), ".bun", "bin", "pi")],
  },
};

/** 各 agent 通用的安装位置(npm 全局 / homebrew / volta / scoop / chocolatey 等)。 */
function commonKnownLocations(binName: string): string[] {
  const home = homedir();
  const paths: string[] = [];

  if (process.platform === "win32") {
    paths.push(join(home, ".local", "bin", `${binName}.exe`));
    paths.push(join(home, ".local", "bin", `${binName}.cmd`));
    // npm global（Windows 上 npm 全局安装只产出 .cmd shim，无 .exe）
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", `${binName}.cmd`));
      paths.push(join(process.env.APPDATA, "npm", `${binName}.exe`));
    }
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", `${binName}.exe`));
    paths.push(join(home, "scoop", "shims", `${binName}.exe`));
    paths.push(join(home, "scoop", "shims", `${binName}.cmd`));
  }

  // Unix (macOS + Linux)
  paths.push(join(home, ".local", "bin", binName));
  paths.push(join(home, ".volta", "bin", binName));
  paths.push(`/usr/local/bin/${binName}`);
  paths.push(`/opt/homebrew/bin/${binName}`);
  paths.push(join(home, ".npm-global", "bin", binName));

  // npm global prefix
  if (process.env.npm_config_prefix) {
    paths.push(join(process.env.npm_config_prefix, "bin", binName));
  }

  return paths;
}

/** 已知安装位置搜索(不含 PATH 查找):agent 特有位置优先,通用位置兜底。 */
function knownLocations(agentType: AgentType): string[] {
  const spec = AGENT_CLI_SPECS[agentType];
  return [
    ...(spec.extraKnownLocations?.() ?? []),
    ...commonKnownLocations(agentType),
  ].filter(isExistingFile);
}

/** 返回某个 agent 类型对应的、可通过 npm 安装的独立 CLI 包名
 *  （区别于内嵌调用用的 SDK 包，如 `@anthropic-ai/claude-agent-sdk`）。 */
export function resolveCliPackageName(agentType: AgentType): string {
  return AGENT_CLI_SPECS[agentType].npmPackage;
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

  await runNpmInstall(dir, [
    resolveCliPackageName(agentType),
    ...(AGENT_CLI_SPECS[agentType].companionPackages ?? []),
  ]);

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

function runNpmInstall(
  cwd: string,
  packageNames: readonly string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      npmCommand,
      [
        "install",
        "--prefix",
        cwd,
        ...packageNames.map((packageName) => `${packageName}@latest`),
      ],
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
