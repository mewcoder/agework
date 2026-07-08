/**
 * 工作空间文件浏览器（纯异步 fs/promises，无运行时依赖）。
 *
 * 提取自 `packages/worker/src/files/workspace-file-browser.ts`，供 worker
 * 和 server（LocalRuntime builtin 直读）共用同一份安全校验 + fs 读取逻辑。
 *
 * 安全校验：相对路径、NUL/`..`/绝对路径拒绝、realpath 前缀判断挡 symlink 逃逸、
 * O_NOFOLLOW 打开文件消除 TOCTOU（Windows 降级为 lstat 预检）。
 *
 * 注意：本文件是 shared 包 `./filesystem` 入口，所有运行时值（函数、常量）
 * 必须内联在本文件中，不可跨文件 re-export——shared 包以源码形式被消费
 * （exports 指向 src 源文件，无 dist），NodeNext 运行时解析跨文件 re-export
 * 需要显式扩展名，而磁盘上是 .ts，会导致 ERR_MODULE_NOT_FOUND。
 * 类型可以用 `import type` 从其他文件引入（编译期擦除）。
 */

import { open, readdir, realpath, stat } from "node:fs/promises";
import { lstat, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import type {
  FileEntry,
  ListFilesResult,
  ReadFileResult,
  WorkspaceFileCommandError,
} from "../protocol/workspace-file-command";

// ── 常量 ──────────────────────────────────────────────────────────

export const TEXT_MAX_BYTES = 1_048_576; // 1 MiB
export const IMAGE_MAX_BYTES = 5_242_880; // 5 MiB
export const DIRECTORY_MAX_ENTRIES = 1000;
export const BINARY_PROBE_BYTES = 8192; // 前 8KiB 含 NUL 即视为二进制
export const FS_TIMEOUT_MS = 8_000; // 比 server 侧 10s 短

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
]);

// ── 类型 ──────────────────────────────────────────────────────────

export type BrowseResult =
  | { ok: true; result: ListFilesResult | ReadFileResult }
  | { ok: false; error: WorkspaceFileCommandError };

// ── 路径安全校验 ───────────────────────────────────────────────────

/**
 * 校验相对路径并返回 join 后的绝对路径。
 * 拒绝：含 NUL 字节、绝对路径、任何 `..` 段。
 */
export function validateRelativePath(
  rootPath: string,
  relativePath: string
): string {
  if (relativePath.includes("\0")) {
    throw new Error("路径包含非法字符");
  }
  if (isAbsolute(relativePath)) {
    throw new Error("不支持绝对路径");
  }
  const parts = relativePath.split(sep).filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === "..") {
      throw new Error("路径不能包含 .. ");
    }
  }
  return join(rootPath, relativePath);
}

/**
 * 解析 realpath 并验证结果仍在 rootPath 之下（前缀 + 分隔符判断），
 * 挡住 symlink 逃逸到 root 外。
 */
export async function resolveWithinRoot(
  rootPath: string,
  absolutePath: string
): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(rootPath),
    realpath(absolutePath).catch(() => {
      throw new Error("路径不存在或不可访问");
    }),
  ]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error("路径越界");
  }
  return realTarget;
}

// ── list_files ────────────────────────────────────────────────────

export async function listFiles(
  rootPath: string,
  relativePath: string,
  signal?: AbortSignal
): Promise<ListFilesResult> {
  const absolutePath = validateRelativePath(rootPath, relativePath);
  const resolved = await withTimeout(
    resolveWithinRoot(rootPath, absolutePath),
    signal
  );

  const dirStat = await withTimeout(stat(resolved), signal);
  if (!dirStat.isDirectory()) {
    throw new Error("路径不是目录");
  }

  const entries = await withTimeout(
    readdir(resolved, { withFileTypes: true }),
    signal
  );

  let truncated = false;
  let limited = entries;
  if (entries.length > DIRECTORY_MAX_ENTRIES) {
    truncated = true;
    limited = entries.slice(0, DIRECTORY_MAX_ENTRIES);
  }

  const fileEntries: FileEntry[] = await Promise.all(
    limited.map(async (entry): Promise<FileEntry> => {
      // lstat 不 follow：是 symlink 就按 symlink 返回，不当成 directory
      const lstatResult = await withTimeout(
        lstatSafe(join(resolved, entry.name)),
        signal
      );

      if (lstatResult?.isSymbolicLink()) {
        const target = await readlinkSafe(join(resolved, entry.name)).catch(
          () => undefined
        );
        const targetType = await resolveSymlinkTargetType(
          join(resolved, entry.name),
          signal
        );
        return {
          name: entry.name,
          type: "symlink",
          ...(target ? { target } : {}),
          targetType,
        };
      }

      if (lstatResult?.isDirectory()) {
        return { name: entry.name, type: "directory" };
      }

      if (lstatResult?.isFile()) {
        return {
          name: entry.name,
          type: "file",
          size: lstatResult.size,
        };
      }

      // socket / fifo / etc → 当 file 返回（不可预览但可展示）
      return {
        name: entry.name,
        type: "file",
        size: lstatResult?.size ?? 0,
      };
    })
  );

  // 目录在前、同类按名字 localeCompare 排序
  fileEntries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    type: "list_files",
    commandId: "",
    path: normalizeRelativePath(relativePath),
    list: fileEntries,
    truncated,
  };
}

// ── read_file ─────────────────────────────────────────────────────

export async function readFile(
  rootPath: string,
  relativePath: string,
  signal?: AbortSignal
): Promise<ReadFileResult> {
  const absolutePath = validateRelativePath(rootPath, relativePath);
  const resolved = await withTimeout(
    resolveWithinRoot(rootPath, absolutePath),
    signal
  );

  // O_NOFOLLOW：如果最后一段是 symlink 则直接失败，消除 realpath 校验与实际
  // 读取之间的 TOCTOU 窗口。
  // Windows 上 O_NOFOLLOW 不存在（undefined），降级为 lstat 预检。
  const fd = await withTimeout(openNoFollow(resolved), signal);

  try {
    const fileStat = await withTimeout(fd.stat(), signal);
    if (!fileStat.isFile()) {
      throw new Error("路径不是普通文件");
    }

    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    const isImage = IMAGE_EXTENSIONS.has(ext);

    if (isImage) {
      return await readImage(fd, fileStat.size, relativePath, ext);
    }

    return await readText(fd, fileStat.size, relativePath);
  } finally {
    await fd.close().catch(() => {});
  }
}

async function readText(
  fd: Awaited<ReturnType<typeof open>>,
  size: number,
  relativePath: string
): Promise<ReadFileResult> {
  // 读前 8KiB 探测二进制
  const probeSize = Math.min(BINARY_PROBE_BYTES, size);
  const probeBuf = Buffer.alloc(probeSize);
  if (probeSize > 0) {
    await fd.read(probeBuf, 0, probeSize, 0);
  }

  if (probeSize > 0 && containsNul(probeBuf.subarray(0, probeSize))) {
    throw new Error("二进制文件不支持预览");
  }

  const readSize = Math.min(size, TEXT_MAX_BYTES);
  const buf = Buffer.alloc(readSize);
  if (readSize > 0) {
    await fd.read(buf, 0, readSize, 0);
  }

  // UTF-8 边界截断：Buffer.toString('utf8') 本身处理多字节字符边界，
  // 截断点在多字节字符中间时用 U+FFFD 替换，不会撕裂。
  const truncated = size > TEXT_MAX_BYTES;
  const content = buf.toString("utf8");

  return {
    type: "read_file",
    commandId: "",
    path: normalizeRelativePath(relativePath),
    encoding: "utf8",
    content,
    size,
    truncated,
  };
}

async function readImage(
  fd: Awaited<ReturnType<typeof open>>,
  size: number,
  relativePath: string,
  ext: string
): Promise<ReadFileResult> {
  if (size > IMAGE_MAX_BYTES) {
    throw new Error("图片过大,暂不支持预览");
  }

  const buf = Buffer.alloc(size);
  if (size > 0) {
    await fd.read(buf, 0, size, 0);
  }

  const mime = imageMime(ext);
  const base64 = buf.toString("base64");

  return {
    type: "read_file",
    commandId: "",
    path: normalizeRelativePath(relativePath),
    encoding: "base64",
    content: `data:${mime};base64,${base64}`,
    size,
    truncated: false,
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────────

function normalizeRelativePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

function containsNul(buf: Buffer): boolean {
  return buf.includes(0);
}

function imageMime(ext: string): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

async function lstatSafe(path: string) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function readlinkSafe(path: string): Promise<string | undefined> {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
}

async function resolveSymlinkTargetType(
  path: string,
  signal?: AbortSignal
): Promise<"directory" | "file" | "unknown"> {
  try {
    const s = await withTimeout(stat(path), signal);
    if (s.isDirectory()) return "directory";
    if (s.isFile()) return "file";
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function openNoFollow(path: string) {
  // O_NOFOLLOW：如果 path 是 symlink 则失败。
  // Windows 上 constants.O_NOFOLLOW 不存在（undefined），降级为先 lstat 检查
  // 是否 symlink，是则拒绝，否则正常 open。
  const oNoFollow = constants.O_NOFOLLOW;
  if (oNoFollow !== undefined) {
    const flags = constants.O_RDONLY | oNoFollow;
    return open(path, flags);
  }
  // Windows 降级路径
  const lst = await lstat(path);
  if (lst.isSymbolicLink()) {
    throw new Error("不允许通过符号链接读取文件");
  }
  return open(path, constants.O_RDONLY);
}

/**
 * 包装 fs 操作，支持 AbortSignal 超时。
 * 如果 signal 已提供且已 abort，直接 reject。
 */
async function withTimeout<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;

  if (signal.aborted) {
    throw new Error("文件系统响应超时");
  }

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("文件系统响应超时")),
        { once: true }
      );
    }),
  ]);
}

/** 创建带超时的 AbortSignal，供 listFiles/readFile 内部使用。 */
export function createFsTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(FS_TIMEOUT_MS);
}

/**
 * 执行文件浏览操作，返回统一的 BrowseResult。
 * 全程 try/catch 到底，不会裸抛——调用方（handler）据此决定如何回传。
 */
export async function browse(
  rootPath: string,
  command: { type: "list_files" | "read_file"; commandId: string; path: string }
): Promise<BrowseResult> {
  const signal = createFsTimeoutSignal();
  try {
    if (command.type === "list_files") {
      const result = await listFiles(rootPath, command.path, signal);
      return {
        ok: true,
        result: { ...result, commandId: command.commandId },
      };
    }
    const result = await readFile(rootPath, command.path, signal);
    return {
      ok: true,
      result: { ...result, commandId: command.commandId },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        type: command.type,
        commandId: command.commandId,
        error: message,
      },
    };
  }
}
