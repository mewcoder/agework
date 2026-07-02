const API_PATH = "/api/v1";

export function normalizePath(value: string | undefined): string {
  const trimmed = value?.trim();

  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === "./" ||
    /^\/+$/.test(trimmed)
  ) {
    return "";
  }

  const normalized = trimmed
    .replace(/^\.\//, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `/${normalized}` : "";
}

export function joinPaths(...paths: string[]): string {
  const joined = paths
    .map((path) => normalizePath(path))
    .filter(Boolean)
    .join("");

  return joined || "/";
}

/** 计算 API 的实际挂载路径：`<appContext>/api/v1`（无 context 时为 `/api/v1`）。 */
export function resolveApiBasePath(appContext: string | undefined): string {
  return joinPaths(normalizePath(appContext), API_PATH);
}
