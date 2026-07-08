/**
 * DirectoryBrowser：runtime manager 侧的目录浏览/新建能力，供 registered
 * 隧道的 runtime.list-dir / runtime.create-dir RPC 调用。只列目录，不列文件。
 * server 端同步副本见 apps/server/src/runtime/filesystem/directory-browser.ts。
 */

import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

export type ListDirectoryResult = { path: string; entries: string[] };
export type CreateDirectoryResult = { path: string };

/** 列出 path 下的子目录（不含文件，entries 为完整绝对路径，不是裸名字——
 *  拼接在这里做一次，前端和 RPC 两端都不用猜这台机器的路径分隔符），按名字排序。
 *  path 省略时：Windows 列出所有可用盘符（虚拟根），其他平台列出用户主目录。 */
export function listDirectory(path?: string): ListDirectoryResult {
  const trimmed = path?.trim();

  // Windows: path 省略时列出所有盘符作为虚拟根目录
  if (!trimmed && process.platform === "win32") {
    const drives = listWindowsDrives();
    return { path: "", entries: drives.map((d) => `${d}\\`) };
  }

  const target = resolveExistingDirectory(trimmed || homedir());
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => join(target, name));
  return { path: target, entries };
}

/** 在 path 下新建目录（含父级），返回新建目录的绝对路径。 */
export function createDirectory(path: string): CreateDirectoryResult {
  const trimmed = path?.trim();
  if (!trimmed) throw new Error("目录路径不能为空");
  const expanded = expandHomePath(trimmed);
  const normalized = normalizeWindowsDrive(expanded);
  if (!isAbsolute(normalized)) throw new Error("目录路径必须是绝对路径");
  mkdirSync(normalized, { recursive: true });
  return { path: realpathSync(normalized) };
}

function resolveExistingDirectory(path: string): string {
  const expanded = expandHomePath(path);
  const normalized = normalizeWindowsDrive(expanded);
  if (!isAbsolute(normalized)) throw new Error("目录路径必须是绝对路径");
  let real: string;
  try {
    real = realpathSync(normalized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`目录不存在或不可访问: ${msg}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error("目录路径必须指向一个目录");
  }
  return real;
}

function expandHomePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Windows 盘符规范化：`C:` → `C:\`。
 * `C:` 在 Windows 上不是绝对路径（表示"C 盘当前目录"），`C:\` 才是。
 * 仅在 Windows 平台生效；非 Windows 原样返回。
 */
function normalizeWindowsDrive(input: string): string {
  if (process.platform !== "win32") return input;
  // `C:` 但后面没有 `\` 或 `/`
  const driveOnly = input.match(/^([A-Za-z]):$/);
  if (driveOnly) return `${driveOnly[1]}:\\`;
  return input;
}

/**
 * 列出 Windows 上所有可用盘符（如 `["C:", "D:", "E:"]`）。
 * 用 wmic（Windows 内置，无需额外依赖）。
 */
function listWindowsDrives(): string[] {
  try {
    const out = execSync("wmic logicaldisk get name", {
      encoding: "utf8",
      timeout: 5_000,
    });
    return out
      .trim()
      .split("\n")
      .slice(1)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // wmic 不可用时回退到只列 C 盘
    return ["C:"];
  }
}
