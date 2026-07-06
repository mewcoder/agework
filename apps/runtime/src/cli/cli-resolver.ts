/**
 * CliResolver：runtime manager 侧的 agent CLI 检测能力。
 * 检测本机 agent CLI 的路径/版本/来源/认证状态，注册时随 register 消息上报给 server。
 * 参考 claudian 的 findClaudeCLIPath + agent-cli-status.ts 的认证检测逻辑。
 */

import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentDetectedEnv, RuntimeEnvConfig } from "@agework/shared/api";
import { claudeKnownLocations, codexKnownLocations } from "./known-locations.js";

/**
 * 检测本机 agent CLI 环境，返回完整的 envConfig（claude + codex）。
 * 注册时和 admin 触发重检时各调一次。
 */
export function detectEnvConfig(): RuntimeEnvConfig {
  return {
    claude: detectAgent("claude"),
    codex: detectAgent("codex"),
    detectedAt: new Date().toISOString(),
  };
}

function detectAgent(agentType: "claude" | "codex"): AgentDetectedEnv {
  const executablePath = resolveCliPath(agentType);
  const version = executablePath ? getVersion(executablePath) : null;
  const authAvailable = checkAuth(agentType);
  return { executablePath, version, authAvailable };
}

/** PATH 查找 + 已知位置搜索，返回第一个找到的路径。 */
function resolveCliPath(agentType: "claude" | "codex"): string | null {
  // 1. PATH 查找（which / where）
  const pathResult = findInPath(agentType);
  if (pathResult) return pathResult;

  // 2. 已知位置搜索
  const known =
    agentType === "claude" ? claudeKnownLocations() : codexKnownLocations();
  return known[0] ?? null;
}

function findInPath(name: string): string | null {
  try {
    // Windows: `where` 查找所有匹配（.exe, .cmd, .ps1, 无扩展名等），取第一个
    // Unix: `which` 只查可执行文件
    const cmd =
      process.platform === "win32"
        ? `where ${name} 2>nul`
        : `which ${name} 2>/dev/null`;
    const result = execSync(cmd, {
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
 *  统一提取第一段 semver 风格的版本号。 */
function getVersion(executablePath: string): string | null {
  try {
    // Windows 上 .cmd / .bat 需要通过 shell 执行
    const result = spawnSync(executablePath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
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

/** 检查本机是否有可用的 agent 认证配置。 */
function checkAuth(agentType: "claude" | "codex"): boolean {
  const home = homedir();

  if (agentType === "claude") {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
    return (
      !!process.env.ANTHROPIC_AUTH_TOKEN ||
      !!process.env.ANTHROPIC_API_KEY ||
      !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      existsSync(join(home, ".claude.json")) ||
      existsSync(join(configDir, ".credentials.json")) ||
      existsSync(join(configDir, "settings.json"))
    );
  }

  return (
    !!process.env.OPENAI_API_KEY ||
    !!process.env.CODEX_API_KEY ||
    existsSync(join(home, ".codex", "auth.json")) ||
    existsSync(join(home, ".codex", "config.toml"))
  );
}
