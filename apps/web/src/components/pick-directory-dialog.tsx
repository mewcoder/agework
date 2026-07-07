import { useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import {
  DirectoryPicker,
  basename as pathBasename,
  type DirectoryListing,
} from "@/components/directory-picker";
import { useRuntimes, useCreateRuntimeDirectory } from "@/hooks/use-runtime";
import { useCreateWorkspace } from "@/hooks/use-workspace";
import { errorMessage } from "@/utils/error";
import { normalizeFilesystemPath } from "@/utils/path";
import { runtimesApi } from "@/api/runtimes";

interface PickDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: string) => void;
}

/**
 * 「选择文件目录」弹窗——快速创建工作空间的捷径。
 *
 * 内含 omnigent 风格的 DirectoryPicker 面板，
 * 选中目录后自动用目录名作为工作空间名称创建。
 */
export function PickDirectoryDialog({
  open,
  onOpenChange,
  onCreated,
}: PickDirectoryDialogProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createWorkspace = useCreateWorkspace();
  const { data: runtimes = [] } = useRuntimes();
  const createDirMutation = useCreateRuntimeDirectory();

  const localRuntimeId = useMemo(
    () =>
      runtimes.find((r) => r.source === "builtin" && r.runtimeType === "local")
        ?.id,
    [runtimes]
  );

  // 注入 DirectoryPicker 的目录列表函数
  const listDirectories = useMemo(() => {
    if (!localRuntimeId) return undefined;
    return async (dir: string | undefined): Promise<DirectoryListing> => {
      const res = await runtimesApi.listDirectory({
        runtimeId: localRuntimeId,
        path: dir,
      });
      return { path: res.path, list: res.list };
    };
  }, [localRuntimeId]);

  // 注入 DirectoryPicker 的新建目录函数
  const createDirectory = useMemo(() => {
    if (!localRuntimeId) return undefined;
    return async (path: string): Promise<string> => {
      const res = await createDirMutation.mutateAsync({
        runtimeId: localRuntimeId,
        path,
      });
      return res.path;
    };
  }, [localRuntimeId, createDirMutation]);

  function reset() {
    setSelectedPath(null);
    setError(null);
    createWorkspace.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleSelect(path: string) {
    setSelectedPath(path);
  }

  async function handleConfirm() {
    if (!selectedPath) return;
    setError(null);

    const rootPath = normalizeFilesystemPath(selectedPath);
    const name = pathBasename(rootPath) || rootPath;

    createWorkspace.mutate(
      { name, rootPath },
      {
        onSuccess: (workspace) => {
          onOpenChange(false);
          onCreated?.(workspace.id);
        },
        onError: (err) => {
          setError(errorMessage(err, "创建工作空间失败"));
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg gap-3">
        <DialogHeader>
          <DialogTitle>选择文件目录</DialogTitle>
          <DialogDescription>
            浏览并选择一个目录作为工作空间，名称自动取目录名
          </DialogDescription>
        </DialogHeader>

        {listDirectories ? (
          <DirectoryPicker
            listDirectories={listDirectories}
            createDirectory={createDirectory}
            onNavigate={handleSelect}
          />
        ) : (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            正在加载运行环境...
          </p>
        )}

        {error && <FieldError>{error}</FieldError>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={createWorkspace.isPending}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!selectedPath || createWorkspace.isPending}
            onClick={() => void handleConfirm()}
          >
            {createWorkspace.isPending ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                创建中...
              </>
            ) : (
              "确定"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
