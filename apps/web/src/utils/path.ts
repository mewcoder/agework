// ---------------------------------------------------------------------------
// 路径工具（兼容 posix / windows 分隔符）
// ---------------------------------------------------------------------------

/** 从完整路径取最后一段。 */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 取父目录路径；到根目录时返回 undefined。 */
export function parentOf(path: string): string | undefined {
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
  // Windows 盘符根的分隔符位置（如 "C:\Users" 的 idx=2）
  // slice(0, idx) 会丢掉反斜杠变成 "C:"，需要保留 → "C:\"
  if (sep === "\\" && /^[A-Za-z]:[\\]$/.test(trimmed.slice(0, idx + 1))) {
    return trimmed.slice(0, idx + 1);
  }
  return trimmed.slice(0, idx);
}

/** 拼接目录路径和子目录名，沿用父目录的分隔符。 */
export function joinPath(dir: string, name: string): string {
  const trimmedName = name.trim();
  if (!dir) return trimmedName;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return `${base}${sep}${trimmedName}`;
}

/** 判断路径是否为 Windows 盘符根（如 "C:\" "D:/" "E:"）。 */
export function isWindowsDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/ .test(path.trim());
}

export function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "." || trimmed === "./" || /^\/+$/.test(trimmed)) {
    return "";
  }

  const normalized = trimmed
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "";
}

/**
 * 归一化用户输入的文件系统目录路径，保证后端可识别。
 * - 去除首尾空白
 * - Windows 反斜杠统一为斜杠
 * - 去掉末尾斜杠（保留根 "/"）
 * - 保留 ~ 前缀不处理（后端 expandHomePath 负责展开）
 *
 * 示例：
 *   "  C:\\Users\\name\\project\\  "  →  "C:/Users/name/project"
 *   "  ~/code/project/  "            →  "~/code/project"
 *   "  /Users/name/project/  "       →  "/Users/name/project"
 */
export function normalizeFilesystemPath(input: string): string {
  let path = input.trim();
  if (!path) return "";

  // 统一 Windows 反斜杠为斜杠
  path = path.replace(/\\/g, "/");

  // 合并多余斜杠
  path = path.replace(/\/+/g, "/");

  // 去掉末尾斜杠（保留单独的 "/"）
  while (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path;
}

/**
 * 检查输入的路径是否看起来像绝对路径（客户端格式预检，不保证服务端可达）。
 */
export function looksLikeAbsolutePath(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    /^[A-Za-z]:[/\\]/.test(trimmed) ||
    trimmed.startsWith("\\\\")
  );
}
