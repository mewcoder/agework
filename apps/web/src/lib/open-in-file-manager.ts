import { toast } from "sonner";
import type { Workspace } from "@/api/workspaces";

const BUILTIN_RUNTIME_HOST_ID = "builtin";

/** 只有跑在本机(builtin runtime host)的 workspace,rootPath 才保证是本机磁盘上的真实路径,才能用本机文件管理器打开。 */
export function isLocalWorkspace(workspace: Pick<Workspace, "runtimeHostId">) {
  return workspace.runtimeHostId === BUILTIN_RUNTIME_HOST_ID;
}

/**
 * 用系统文件管理器打开本地路径(仅 Electron 桌面壳可用)。relativePath 交给 Electron
 * 主进程用 node:path join,不在渲染进程里拼字符串,避免 Windows 下 "/" 与 "\" 混用。
 */
export async function openInFileManager(rootPath: string, relativePath?: string) {
  const openPath = window.agework?.openPath;
  if (!openPath) return;
  const result = await openPath(rootPath, relativePath);
  if (!result.ok) {
    toast.error(result.error ?? "打开失败");
  }
}
