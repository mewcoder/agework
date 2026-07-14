/* eslint-disable react-refresh/only-export-components -- 路径工具函数与组件紧耦合 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { FolderIcon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// 路径工具（兼容 posix / windows 分隔符）
// ---------------------------------------------------------------------------

/** 从完整路径取最后一段。 */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * 把用户输入拆成「要列的目录」+「过滤片段」。
 *
 * - `dir` 为 `undefined` 表示主目录（让调用方决定怎么请求）
 * - `partial` 为空字符串表示不过滤
 *
 * @example
 * splitPath("/Users/me/pro") → { dir: "/Users/me", partial: "pro" }
 * splitPath("/Users/me/")    → { dir: "/Users/me", partial: "" }
 * splitPath("/Users")        → { dir: "/",        partial: "Users" }
 * splitPath("")              → { dir: undefined,   partial: "" }
 * splitPath("pro")           → { dir: undefined,   partial: "pro" }
 */
export function splitPath(
  input: string
): { dir: string | undefined; partial: string } {
  const trimmed = input.trim();
  if (!trimmed) return { dir: undefined, partial: "" };

  const normalized = trimmed.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) {
    return { dir: undefined, partial: trimmed };
  }
  const partial = normalized.slice(slash + 1);
  const dir = normalized.slice(0, slash) || "/";
  return { dir, partial };
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

/** 注入的数据获取函数。返回某个目录下的子目录列表。
 *  传入 `undefined` 表示列出主目录。 */
export type ListDirectoriesFn = (
  path: string | undefined
) => Promise<DirectoryListing>;

// ---------------------------------------------------------------------------
// PathCombobox
// ---------------------------------------------------------------------------

interface PathComboboxProps {
  /** 当前路径值。 */
  value: string;
  /** 值变化回调。 */
  onChange: (value: string) => void;
  /**
   * 注入目录列表获取函数。传入 `undefined` 时不显示下拉。
   * 组件内部会缓存请求结果，不在这里做——调用方可以用 React Query 等。
   */
  listDirectories?: ListDirectoriesFn;
  /** placeholder。 */
  placeholder?: string;
  /** 禁用。 */
  disabled?: boolean;
  /** 输入框 id。 */
  id?: string;
  /** 输入框 name。 */
  name?: string;
  /** 自定义 className（加在最外层 div 上）。 */
  className?: string;
  /** 输入框右侧额外内容（如原生目录选择按钮）。 */
  trailing?: ReactNode;
  /** 选中某个目录后的回调（区别于 onChange，只在下拉选中时触发）。 */
  onSelect?: (path: string) => void;
  /** 失焦时归一化路径的回调（如去掉末尾斜杠）。 */
  onNormalize?: (value: string) => string;
}

/**
 * 路径 combobox：输入框 + 下方目录匹配下拉。
 *
 * - 不绑定任何具体数据源——通过 `listDirectories` 注入获取逻辑
 * - 聚焦 / 输入时自动列出父目录的子目录，按输入片段前缀过滤
 * - ↑↓ 键导航，Enter 选中，Escape / 点击外部关闭
 * - 选中后填充路径并关闭下拉
 * - 不传 `listDirectories` 时退化为普通输入框
 *
 * @example
 * ```tsx
 * <PathCombobox
 *   value={path}
 *   onChange={setPath}
 *   listDirectories={(dir) => runtimesApi.listDirectory({ runtimeHostId, path: dir })}
 *   placeholder="/Users/you/projects/app"
 * />
 * ```
 */
export function PathCombobox({
  value,
  onChange,
  listDirectories,
  placeholder,
  disabled,
  id,
  name,
  className,
  trailing,
  onSelect,
  onNormalize,
}: PathComboboxProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 防止 blur 关闭下拉与 mousedown 选中冲突
  const suppressBlurRef = useRef(false);

  const { dir, partial } = splitPath(value);

  // 下拉打开时请求目录列表
  useEffect(() => {
    if (!open || !listDirectories) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading 状态是 fetch 副作用，必须在请求开始时同步设置
    setLoading(true);
    listDirectories(dir)
      .then((result) => {
        if (!cancelled) {
          setListing(result);
          setHighlight(-1);
        }
      })
      .catch(() => {
        if (!cancelled) setListing(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, dir, listDirectories]);

  // 过滤匹配的目录
  const lowerPartial = partial.toLowerCase();
  const matches = (listing?.list ?? [])
    .filter((entry) => {
      if (!partial) return true;
      return basename(entry).toLowerCase().startsWith(lowerPartial);
    })
    .sort((a, b) => basename(a).localeCompare(basename(b)));

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setHighlight(-1);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 高亮行滚动到可视区
  useEffect(() => {
    if (highlight < 0) return;
    const el = containerRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  function select(path: string) {
    onChange(path);
    setOpen(false);
    setHighlight(-1);
    onSelect?.(path);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (!listDirectories) return;
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (matches.length > 0) {
        setHighlight((h) => Math.min(h + 1, matches.length - 1));
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, -1));
    } else if (e.key === "Enter") {
      if (open && highlight >= 0 && highlight < matches.length) {
        e.preventDefault();
        select(matches[highlight]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
      }
    }
  }

  function handleBlur() {
    // 延迟关闭，让 mousedown 选中先触发
    if (suppressBlurRef.current) return;
    setTimeout(() => {
      if (!containerRef.current?.contains(document.activeElement)) {
        setOpen(false);
        setHighlight(-1);
      }
    }, 150);
    if (onNormalize) {
      const normalized = onNormalize(value);
      if (normalized !== value) onChange(normalized);
    }
  }

  const canShowDropdown = !!listDirectories;
  const showDropdown =
    open && canShowDropdown && (matches.length > 0 || loading);

  return (
    <div ref={containerRef} className={cn("relative flex items-center gap-2", className)}>
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            if (canShowDropdown) {
              setOpen(true);
              setHighlight(-1);
            }
          }}
          onFocus={() => canShowDropdown && setOpen(true)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role={canShowDropdown ? "combobox" : undefined}
          aria-expanded={canShowDropdown ? showDropdown : undefined}
          aria-autocomplete={canShowDropdown ? "list" : undefined}
          aria-controls={canShowDropdown ? "path-combobox-listbox" : undefined}
        />
        {trailing}
      </div>

      {showDropdown && (
        <div
          id="path-combobox-listbox"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {loading && matches.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" /> 加载中...
            </div>
          )}
          {!loading && matches.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              没有匹配的目录
            </div>
          )}
          {matches.map((entry, i) => {
            const name = basename(entry);
            const active = i === highlight;
            return (
              <button
                key={entry}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  suppressBlurRef.current = true;
                  select(entry);
                  suppressBlurRef.current = false;
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {active ? (
                  <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="flex-1 truncate">{name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {entry}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
