/**
 * DirectoryBrowser：runtime manager 侧的目录浏览/新建能力，供 registered
 * 隧道的 runtime.list-dir / runtime.create-dir RPC 调用。只列目录，不列文件。
 * server 端同步副本见 apps/server/src/runtime/filesystem/directory-browser.ts。
 */

import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type ListDirectoryResult = { path: string; entries: string[] };
export type CreateDirectoryResult = { path: string };

/** 列出 path 下的子目录（不含文件，entries 为完整绝对路径，不是裸名字——
 *  拼接在这里做一次，前端和 RPC 两端都不用猜这台机器的路径分隔符），按名字排序。
 *  path 省略时列出用户主目录。 */
export function listDirectory(path?: string): ListDirectoryResult {
  const target = resolveExistingDirectory(path?.trim() || homedir());
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
  if (!isAbsolute(expanded)) throw new Error("目录路径必须是绝对路径");
  mkdirSync(expanded, { recursive: true });
  return { path: realpathSync(expanded) };
}

function resolveExistingDirectory(path: string): string {
  const expanded = expandHomePath(path);
  if (!isAbsolute(expanded)) throw new Error("目录路径必须是绝对路径");
  let real: string;
  try {
    real = realpathSync(expanded);
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
