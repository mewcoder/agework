import { useEffect, useRef, useState } from "react";
import {
  ArrowUpIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 路径工具（兼容 posix / windows 分隔符）
// ---------------------------------------------------------------------------

/** 从完整路径取最后一段。 */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 取父目录路径；到根目录时返回 undefined。 */
function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (!trimmed) return undefined;

  // Windows 盘符根（"C:" 或 "C:\"）没有父目录
  if (/^[A-Za-z]:\\?$/.test(trimmed)) return undefined;

  const sep = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) {
    if (sep === "\\") {
      const driveMatch = trimmed.match(/^([A-Za-z]:)/);
      if (driveMatch) return `${driveMatch[1]}\\`;
      return undefined;
    }
    return "/";
  }
  return trimmed.slice(0, idx);
}

/** 拼接目录路径和子目录名，沿用父目录的分隔符。 */
function joinPath(dir: string, name: string): string {
  const trimmedName = name.trim();
  if (!dir) return trimmedName;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return `${base}${sep}${trimmedName}`;
}

/** 归一化用户输入的路径：trim、反斜杠转正斜杠、合并多余斜杠、去末尾斜杠。
 *  返回 null 表示输入不可用。 */
function normalizeTypedPath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path = trimmed.replace(/\\/g, "/");
  path = path.replace(/\/+/g, "/");

  if (path === "/") return "/";
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path;
}

/** 路径栏文本是否可导航（绝对路径或 ~ 前缀）。 */
function isNavigablePath(path: string): boolean {
  const trimmed = path.trim();
  return (
    trimmed.startsWith("/") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[/\\]/.test(trimmed)
  );
}

/** 根据路径栏文本计算当前目录的过滤片段（shell 风格 tab 补全）。
 *  返回 null 表示不过滤。 */
function listingFilter(
  pathInput: string,
  currentPath: string
): string | null {
  const trimmed = pathInput.trim();
  if (!trimmed) return null;

  const normalized = normalizeTypedPath(trimmed);
  if (!normalized) return null;

  const slash = normalized.lastIndexOf("/");
  if (slash === -1) {
    return trimmed;
  }

  const partial = normalized.slice(slash + 1);
  if (!partial) return null;

  const dirPart = normalized.slice(0, slash) || "/";
  const currentNormalized = currentPath.replace(/\\/g, "/");
  return dirPart === currentNormalized ? partial : null;
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 目录列表请求的结果。 */
export interface DirectoryListing {
  /** 当前目录的绝对路径。 */
  path: string;
  /** 子目录的完整绝对路径列表。 */
  list: string[];
}

/** 注入的数据获取函数。传入 undefined 表示列出主目录。 */
export type ListDirectoriesFn = (
  path: string | undefined
) => Promise<DirectoryListing>;

/** 注入的新建目录函数。 */
export type CreateDirectoryFn = (
  path: string
) => Promise<string>;

// ---------------------------------------------------------------------------
// DirectoryPicker — omnigent 风格目录浏览面板
// ---------------------------------------------------------------------------

interface DirectoryPickerProps {
  /** 注入目录列表获取函数。 */
  listDirectories: ListDirectoriesFn;
  /** 注入新建目录函数。不传则隐藏新建按钮。 */
  createDirectory?: CreateDirectoryFn;
  /** 初始路径。undefined 表示主目录。 */
  initialPath?: string;
  /** 当前目录变化时回调，传入绝对路径。每次目录列表加载回来触发。 */
  onNavigate: (path: string) => void;
}

/**
 * 目录浏览面板——工具栏 + 可滚动目录列表。
 *
 * 参考 omnigent WorkspacePicker 的交互模式：
 * - 顶部工具栏：↑上一级 / 🏠主目录 / 可编辑路径栏 / 👁显示隐藏 / 📁+新建文件夹 / ✓选择
 * - 点击文件夹进入子目录，点击↑返回上级
 * - 路径栏可编辑：回车跳转、输入片段自动过滤当前目录列表
 * - 新建文件夹：内联表单，Enter 创建，Escape 取消
 *
 * 不绑定具体数据源——通过 `listDirectories` / `createDirectory` 注入。
 */
export function DirectoryPicker({
  listDirectories,
  createDirectory,
  initialPath,
  onNavigate,
}: DirectoryPickerProps) {
  // undefined = 主目录；string = 指定路径
  const [path, setPath] = useState<string | undefined>(initialPath);
  // 路径栏的可编辑文本，与 path 分离——用户编辑时不被 listing 回来覆盖
  const [pathInput, setPathInput] = useState("");
  // listing 结果
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 是否显示隐藏目录（. 开头）
  const [showHidden, setShowHidden] = useState(false);
  // 新建文件夹表单：null = 关闭，string = 正在输入名称
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 跟踪用户是否正在编辑路径栏
  const userEditedRef = useRef(false);
  // 防止重复请求
  const reqIdRef = useRef(0);

  // 路径变化时请求目录列表
  useEffect(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setLoadError(null);
    listDirectories(path)
      .then((result) => {
        if (reqId !== reqIdRef.current) return;
        setListing(result);
        if (result.path) onNavigate(result.path);
      })
      .catch((err) => {
        if (reqId !== reqIdRef.current) return;
        setLoadError(err instanceof Error ? err.message : "加载目录失败");
        setListing(null);
      })
      .finally(() => {
        if (reqId !== reqIdRef.current) return;
        setLoading(false);
      });
  }, [path, listDirectories]);

  // listing 回来后同步路径栏（除非用户正在编辑）
  useEffect(() => {
    if (userEditedRef.current) return;
    setPathInput(listing?.path ?? "");
  }, [listing?.path]);

  function navigateTo(next: string | undefined) {
    userEditedRef.current = false;
    setPath(next);
  }

  function commitPathInput() {
    const normalized = normalizeTypedPath(pathInput);
    userEditedRef.current = false;
    if (!normalized || !isNavigablePath(normalized)) {
      setPathInput(listing?.path ?? "");
      return;
    }
    const currentNormalized = (listing?.path ?? "").replace(/\\/g, "/");
    if (normalized !== currentNormalized) {
      navigateTo(normalized);
    } else {
      setPathInput(listing?.path ?? "");
    }
  }

  async function handleCreateFolder() {
    const name = (newFolderName ?? "").trim();
    if (!name || !createDirectory || !listing?.path) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createDirectory(joinPath(listing.path, name));
      setNewFolderName(null);
      setCreateError(null);
      navigateTo(created);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "创建文件夹失败");
    } finally {
      setCreating(false);
    }
  }

  // 当前目录的绝对路径
  const currentPath = listing?.path ?? "";
  const parent = parentOf(currentPath);

  // 实时过滤片段
  const activeFilter = currentPath
    ? listingFilter(pathInput, currentPath)
    : null;
  const includeHidden =
    showHidden || (activeFilter?.startsWith(".") ?? false);

  // 过滤 + 排序后的目录列表
  const entries = (listing?.list ?? [])
    .filter((entry) => {
      const name = basename(entry);
      if (!includeHidden && name.startsWith(".")) return false;
      if (activeFilter) {
        return name.toLowerCase().startsWith(activeFilter.toLowerCase());
      }
      return true;
    })
    .sort((a, b) => basename(a).localeCompare(basename(b)));

  return (
    <div className="flex max-h-80 min-h-0 flex-col rounded-md border">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-1.5 py-1.5">
        <button
          type="button"
          onClick={() => parent !== undefined && navigateTo(parent)}
          disabled={parent === undefined || loading}
          aria-label="上一级"
          title="上一级"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
        >
          <ArrowUpIcon className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => navigateTo(undefined)}
          disabled={loading}
          aria-label="主目录"
          title="主目录"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
        >
          <HomeIcon className="size-4" />
        </button>
        <input
          type="text"
          value={pathInput}
          onChange={(e) => {
            userEditedRef.current = true;
            setPathInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitPathInput();
            }
          }}
          onBlur={commitPathInput}
          placeholder="输入路径并按回车跳转"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-xs text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          aria-label={showHidden ? "隐藏隐藏目录" : "显示隐藏目录"}
          aria-pressed={showHidden}
          title={showHidden ? "隐藏隐藏目录" : "显示隐藏目录"}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {showHidden ? (
            <EyeIcon className="size-4" />
          ) : (
            <EyeOffIcon className="size-4" />
          )}
        </button>
        {createDirectory && (
          <button
            type="button"
            onClick={() => {
              setCreateError(null);
              setNewFolderName("");
            }}
            disabled={!currentPath || loading}
            aria-label="新建文件夹"
            title="新建文件夹"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
          >
            <FolderPlusIcon className="size-4" />
          </button>
        )}
      </div>

      {/* 新建文件夹表单 */}
      {newFolderName !== null && (
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            value={newFolderName}
            onChange={(e) => {
              setNewFolderName(e.target.value);
              if (createError) setCreateError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreateFolder();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNewFolderName(null);
                setCreateError(null);
              }
            }}
            placeholder="新文件夹名称"
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground focus:outline-none"
          />
          <button
            type="button"
            disabled={!newFolderName.trim() || creating}
            onClick={() => void handleCreateFolder()}
            aria-label="创建文件夹"
            title="创建"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
          >
            <CheckIcon className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setNewFolderName(null);
              setCreateError(null);
            }}
            aria-label="取消新建"
            title="取消"
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}
      {createError && (
        <p className="shrink-0 border-b px-2 py-1.5 text-xs text-destructive">
          {createError}
        </p>
      )}

      {/* 目录列表 */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1">
          {loading && (
            <div className="space-y-2 p-2">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          )}
          {loadError && !loading && (
            <p className="p-3 text-xs text-destructive">{loadError}</p>
          )}
          {listing && entries.length === 0 && !loading && (
            <p className="p-3 text-xs text-muted-foreground">
              {activeFilter ? "没有匹配的目录" : "没有子目录"}
            </p>
          )}
          {entries.map((entry) => {
            const name = basename(entry);
            return (
              <button
                key={entry}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => navigateTo(entry)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{name}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      {/* 底部状态 */}
      {loading && (
        <div className="shrink-0 border-t px-2 py-1 text-xs text-muted-foreground">
          <Loader2Icon className="inline size-3 animate-spin" /> 加载中...
        </div>
      )}
    </div>
  );
}
