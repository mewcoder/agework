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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DirectoryPicker, type DirectoryListing } from "@/components/directory-picker";
import { useRuntimes, useCreateRuntimeDirectory } from "@/hooks/use-runtime";
import { useCreateWorkspace } from "@/hooks/use-workspace";
import { errorMessage } from "@/utils/error";
import { basename as pathBasename, normalizeFilesystemPath } from "@/utils/path";
import { runtimesApi } from "@/api/runtimes";
import type { WorkspaceRuntimeType } from "@agework/shared/api";

interface PickDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspaceId: string) => void;
}

function runtimeTypeLabel(type: WorkspaceRuntimeType | null) {
  switch (type) {
    case "native":
      return "本地";
    case "docker":
      return "Docker";
    case "opensandbox":
      return "OpenSandbox";
    default:
      return "未知";
  }
}

/**
 * 「选择本地文件夹」弹窗——快速创建工作空间的捷径。
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
  const [runtimeOverrideId, setRuntimeOverrideId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const createWorkspace = useCreateWorkspace();
  const { data: runtimes = [] } = useRuntimes();
  const createDirMutation = useCreateRuntimeDirectory();

  // managed runtime 都跑在 server 所在这台机器上,「选择本地文件夹」只在这些之间选,
  // 不含已配对的远程机器(那台机器上的目录不属于"本地")。
  const managedRuntimes = useMemo(
    () => runtimes.filter((r) => r.source === "managed"),
    [runtimes]
  );

  const defaultRuntimeId =
    (managedRuntimes.find((r) => r.runtimeType === "native") ??
      managedRuntimes[0])?.id;
  const selectedRuntimeId = runtimeOverrideId ?? defaultRuntimeId;

  const selectedRuntime = managedRuntimes.find(
    (r) => r.id === selectedRuntimeId
  );

  function handleRuntimeChange(runtimeId: string | null) {
    if (!runtimeId) return;
    setRuntimeOverrideId(runtimeId);
    setSelectedPath(null);
  }

  // 注入 DirectoryPicker 的目录列表函数
  const listDirectories = useMemo(() => {
    if (!selectedRuntimeId) return undefined;
    return async (dir: string | undefined): Promise<DirectoryListing> => {
      const res = await runtimesApi.listDirectory({
        runtimeId: selectedRuntimeId,
        path: dir,
      });
      return { path: res.path, list: res.list };
    };
  }, [selectedRuntimeId]);

  // 注入 DirectoryPicker 的新建目录函数
  const createDirectory = useMemo(() => {
    if (!selectedRuntimeId) return undefined;
    return async (path: string): Promise<string> => {
      const res = await createDirMutation.mutateAsync({
        runtimeId: selectedRuntimeId,
        path,
      });
      return res.path;
    };
  }, [selectedRuntimeId, createDirMutation]);

  function reset() {
    setSelectedPath(null);
    setRuntimeOverrideId(undefined);
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
    if (!selectedPath || !selectedRuntime?.runtimeType) return;
    setError(null);

    const rootPath = normalizeFilesystemPath(selectedPath);
    const name = pathBasename(rootPath) || rootPath;
    const runtimeType = selectedRuntime.runtimeType as WorkspaceRuntimeType;

    createWorkspace.mutate(
      {
        name,
        rootPath,
        runtimeType,
        isolationScope: runtimeType !== "native" ? "workspace" : undefined,
      },
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
          <DialogTitle>选择本地文件夹</DialogTitle>
          <DialogDescription>
            浏览并选择一个目录作为工作空间，名称自动取目录名
          </DialogDescription>
        </DialogHeader>

        {managedRuntimes.length > 1 && (
          <Field>
            <FieldLabel htmlFor="pick-directory-runtime">运行环境</FieldLabel>
            <Select
              items={managedRuntimes.map((runtime) => ({
                value: runtime.id,
                label: runtime.name,
              }))}
              value={selectedRuntimeId}
              onValueChange={handleRuntimeChange}
            >
              <SelectTrigger id="pick-directory-runtime" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {managedRuntimes.map((runtime) => (
                  <SelectItem key={runtime.id} value={runtime.id}>
                    {runtime.name}
                    <span className="text-xs text-muted-foreground">
                      {runtimeTypeLabel(runtime.runtimeType as WorkspaceRuntimeType | null)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

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
