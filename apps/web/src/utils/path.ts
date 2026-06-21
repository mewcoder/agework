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
