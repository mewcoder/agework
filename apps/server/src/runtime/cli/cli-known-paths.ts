/**
 * Agent CLI 已知安装位置搜索（server 端本地检测副本）。
 * 逻辑与 apps/runtime/src/cli/cli-known-paths.ts 保持一致。
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export function claudeKnownLocations(): string[] {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const paths: string[] = [];

  if (isWindows) {
    paths.push(join(home, ".claude", "local", "claude.exe"));
    paths.push(join(home, "AppData", "Local", "Claude", "claude.exe"));
    paths.push(join(process.env.ProgramFiles || "C:\\Program Files", "Claude", "claude.exe"));
    paths.push(join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Claude", "claude.exe"));
    paths.push(join(home, ".local", "bin", "claude.exe"));
    // npm global
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", "claude.exe"));
      paths.push(join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js"));
    }
    // chocolatey
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", "claude.exe"));
    // scoop
    paths.push(join(home, "scoop", "shims", "claude.exe"));
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

  // nvm default version bin
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const nvmDefault = join(nvmDir, "versions", "node");
  if (existsSync(nvmDefault)) {
    // nvm 的 default 不确定版本，这里只加一个常见路径
  }

  return paths.filter(isExistingFile);
}

/** Codex CLI 已知安装位置。 */
export function codexKnownLocations(): string[] {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const paths: string[] = [];

  if (isWindows) {
    paths.push(join(home, ".local", "bin", "codex.exe"));
    if (process.env.APPDATA) {
      paths.push(join(process.env.APPDATA, "npm", "codex.exe"));
    }
    paths.push(join("C:\\ProgramData", "chocolatey", "bin", "codex.exe"));
    paths.push(join(home, "scoop", "shims", "codex.exe"));
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
