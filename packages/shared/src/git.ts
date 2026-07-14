/**
 * 工作空间 git 变更查看（纯 child_process，无运行时依赖）。
 *
 * 语义（见 docs/todo/workspace-diff-and-versioning-design.md，本次收窄为只 local）：
 * git-only、累计 vs HEAD、只读。server 就是文件 owner，直接在本机 workspace 目录
 * 上跑 git，不经 worker。
 *
 * 注意：本文件是 shared 包 `./git` 入口，所有运行时值（函数、类、常量）必须
 * 内联在本文件中，不可跨文件 re-export——shared 包以源码形式被消费（exports 指向
 * src 源文件，无 dist），NodeNext 运行时解析跨文件 re-export 需要显式扩展名，而磁盘
 * 上是 .ts，会导致 ERR_MODULE_NOT_FOUND。类型可以用 `import type` 从其他文件引入
 * （编译期擦除，不影响运行时）。
 */

import { execFile } from "node:child_process";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import type {
  ChangedFileEntry,
  WorkspaceChangeStatus,
} from "./filesystem/types";

// ── 常量 ──────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024; // 16 MiB
const CHANGED_FILES_LIMIT = 500;
const DIFF_MAX_BYTES = 1_048_576; // 1 MiB，任一侧超出即拒绝对比

// ── 错误 ──────────────────────────────────────────────────────────

/** 目标目录不是 git 仓库（`git rev-parse --git-dir` 失败）。上层据此区分「非 git」与「git 命令失败」。 */
export class NotGitRepositoryError extends Error {
  constructor(root: string) {
    super(`不是 git 仓库: ${root}`);
    this.name = "NotGitRepositoryError";
  }
}

// ── 路径安全校验（自包含，不跨文件 import 运行时值） ─────────────────

/**
 * 校验相对路径并返回 join 后的绝对路径。
 * 拒绝：含 NUL 字节、绝对路径、任何 `..` 段。
 */
function validateRelativePath(rootPath: string, relativePath: string): string {
  if (!relativePath) {
    throw new Error("路径不能为空");
  }
  if (relativePath.includes("\0")) {
    throw new Error("路径包含非法字符");
  }
  if (isAbsolute(relativePath)) {
    throw new Error("不支持绝对路径");
  }
  const parts = relativePath.split(/[\\/]/).filter((p) => p.length > 0);
  for (const part of parts) {
    if (part === "..") {
      throw new Error("路径不能包含 .. ");
    }
  }
  return join(rootPath, relativePath);
}

// ── git 子进程（数组传参防注入，5s 超时） ──────────────────────────

function execGitText(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as string);
      }
    );
  });
}

function execGitBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout as Buffer);
      }
    );
  });
}

async function assertGitRepository(root: string): Promise<void> {
  try {
    await execGitText(["-C", root, "rev-parse", "--git-dir"]);
  } catch {
    throw new NotGitRepositoryError(root);
  }
}

// ── listChangedFiles ──────────────────────────────────────────────

/**
 * 列出工作区相对 HEAD 的累计变更（index + working tree），含未跟踪文件。
 * 非 git 目录抛 {@link NotGitRepositoryError}；git 命令超时/非零退出直接抛错
 * （不返回空列表，避免把「失败」伪装成「无变更」）。
 */
export async function listChangedFiles(
  root: string
): Promise<{ list: ChangedFileEntry[]; truncated: boolean }> {
  await assertGitRepository(root);

  const [statusOut, numstatOut] = await Promise.all([
    execGitText([
      "-C",
      root,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]),
    execGitText(["-C", root, "diff", "HEAD", "--numstat", "-z"]),
  ]);

  const numstat = parseNumstat(numstatOut);
  const parsed = parseStatus(statusOut);

  const entries: ChangedFileEntry[] = [];
  for (const item of parsed) {
    if (isGitInternalPath(item.path)) continue;
    const stat = numstat.get(item.path);
    entries.push({
      path: item.path,
      status: item.status,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
    });
  }

  const truncated = entries.length > CHANGED_FILES_LIMIT;
  return {
    list: truncated ? entries.slice(0, CHANGED_FILES_LIMIT) : entries,
    truncated,
  };
}

function isGitInternalPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

type ParsedStatus = {
  path: string;
  status: WorkspaceChangeStatus;
  oldPath?: string;
};

/**
 * 解析 `git status --porcelain=v1 -z`：记录以 NUL 分隔，格式 `XY <path>`；
 * rename/copy(R/C)条目后紧跟一个额外的 NUL 段表示 old path，需多消费一个 token。
 */
function parseStatus(out: string): ParsedStatus[] {
  const tokens = out.split("\0");
  const result: ParsedStatus[] = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    if (!entry) {
      i += 1;
      continue;
    }
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      // -z 模式下 rename/copy 的 old path 是下一个 NUL 段
      const oldPath = tokens[i + 1] ?? "";
      result.push({ path, status: "renamed", oldPath });
      i += 2;
    } else {
      result.push({ path, status: mapStatus(xy) });
      i += 1;
    }
  }
  return result;
}

function mapStatus(xy: string): WorkspaceChangeStatus {
  if (xy === "??" || xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

/**
 * 解析 `git diff HEAD --numstat -z`：正常记录 `add\tdel\tpath`；rename 记录
 * `add\tdel\t`（path 段为空）后跟两个 NUL 段 oldPath、newPath。二进制文件的
 * add/del 为 `-` → null。key 用（新）path。
 */
function parseNumstat(
  out: string
): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) {
      i += 1;
      continue;
    }
    const parts = tok.split("\t");
    const additions = parseNumstatCount(parts[0]);
    const deletions = parseNumstatCount(parts[1]);
    const pathField = parts[2] ?? "";
    if (pathField === "") {
      // rename：接下来两个 token 是 oldPath、newPath
      const newPath = tokens[i + 2] ?? "";
      if (newPath) map.set(newPath, { additions, deletions });
      i += 3;
    } else {
      map.set(pathField, { additions, deletions });
      i += 1;
    }
  }
  return map;
}

function parseNumstatCount(raw: string | undefined): number | null {
  if (raw === undefined || raw === "-" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── readFileDiff ──────────────────────────────────────────────────

/**
 * 返回单文件的 before(HEAD)/after(工作区当前内容)对比。
 * - before = `git show HEAD:<path>`（HEAD 无此文件 → null = 新增）；
 * - after = 读当前盘文件（已删除 → null）；
 * - 任一侧 > 1 MiB → 抛「文件过大」（不做截断 diff）；
 * - 任一侧二进制（NUL 探测）→ 抛「二进制文件不支持对比」。
 */
export async function readFileDiff(
  root: string,
  path: string
): Promise<{
  path: string;
  status: WorkspaceChangeStatus;
  before: string | null;
  after: string | null;
}> {
  const absolutePath = validateRelativePath(root, path);
  await assertGitRepository(root);

  const gitPath = path.replace(/\\/g, "/");
  const beforeBuf = await readHeadBlob(root, gitPath);
  const afterBuf = await readDiskFile(absolutePath);

  if (beforeBuf === null && afterBuf === null) {
    throw new Error("文件不存在");
  }

  assertDiffable(beforeBuf);
  assertDiffable(afterBuf);

  let status: WorkspaceChangeStatus;
  if (beforeBuf === null) status = "added";
  else if (afterBuf === null) status = "deleted";
  else status = "modified";

  return {
    path: gitPath,
    status,
    before: beforeBuf === null ? null : beforeBuf.toString("utf8"),
    after: afterBuf === null ? null : afterBuf.toString("utf8"),
  };
}

/** HEAD 里的文件内容；不存在(git show 失败) → null。 */
async function readHeadBlob(
  root: string,
  gitPath: string
): Promise<Buffer | null> {
  try {
    return await execGitBuffer(["-C", root, "show", `HEAD:${gitPath}`]);
  } catch {
    return null;
  }
}

/** 当前工作区文件内容；不存在(ENOENT) → null，其它错误抛出。 */
async function readDiskFile(absolutePath: string): Promise<Buffer | null> {
  try {
    return await readFileFromDisk(absolutePath);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

function assertDiffable(buf: Buffer | null): void {
  if (buf === null) return;
  if (buf.length > DIFF_MAX_BYTES) {
    throw new Error("文件过大,暂不支持对比");
  }
  if (buf.includes(0)) {
    throw new Error("二进制文件不支持对比");
  }
}
