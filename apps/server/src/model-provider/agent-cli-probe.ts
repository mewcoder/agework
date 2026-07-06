/**
 * 系统环境模型服务的诊断：探测本机是否装了对应 agent CLI、是否有可用认证配置。
 * 纯函数集合，不接触数据库，只读 OS 进程/文件系统/环境变量。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type SystemStatus = {
  command: string;
  commandAvailable: boolean;
  configAvailable: boolean;
};

function isCommandAvailable(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    timeout: 1500,
  });
  return !result.error && result.status === 0;
}

function claudeConfigDir(home: string): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
}

function hasClaudeAuthEnv(): boolean {
  return (
    !!process.env.ANTHROPIC_AUTH_TOKEN ||
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  );
}

function hasClaudeConfigFiles(home: string): boolean {
  const configDir = claudeConfigDir(home);
  return (
    existsSync(join(home, ".claude.json")) ||
    existsSync(join(configDir, ".credentials.json")) ||
    existsSync(join(configDir, "settings.json"))
  );
}

export function getSystemStatus(agentType: string): SystemStatus {
  const home = homedir();

  if (agentType === "claude") {
    return {
      command: "claude",
      commandAvailable: isCommandAvailable("claude"),
      configAvailable: hasClaudeAuthEnv() || hasClaudeConfigFiles(home),
    };
  }

  return {
    command: "codex",
    commandAvailable: isCommandAvailable("codex"),
    configAvailable:
      !!process.env.OPENAI_API_KEY ||
      !!process.env.CODEX_API_KEY ||
      existsSync(join(home, ".codex", "auth.json")) ||
      existsSync(join(home, ".codex", "config.toml")),
  };
}
