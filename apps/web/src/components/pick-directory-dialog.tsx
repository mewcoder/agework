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
import {
  DirectoryPicker,
  type DirectoryListing,
} from "@/components/directory-picker";
import { useRuntimes, useCreateRuntimeDirectory } from "@/hooks/use-runtime";
import { useCreateWorkspace } from "@/hooks/use-workspace";
import { errorMessage } from "@/utils/error";
import {
  basename as pathBasename,
  normalizeFilesystemPath,
} from "@/utils/path";
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
  const [runtimeHostOverrideId, setRuntimeHostOverrideId] = useState<
    string | undefined
  >(undefined);
  const [error, setError] = useState<string | null>(null);

  const createWorkspace = useCreateWorkspace();
  const { data: runtimes = [] } = useRuntimes();
  const createDirMutation = useCreateRuntimeDirectory();

  // builtin Host 就在 server 所在机器上；「选择本地文件夹」只在这里浏览，
  // 不含已配对的远程机器(那台机器上的目录不属于"本地")。
  const builtinRuntimes = useMemo(
    () => runtimes.filter((r) => r.source === "builtin"),
    [runtimes]
  );

  const defaultRuntimeHostId = builtinRuntimes[0]?.id;
  const selectedRuntimeHostId = runtimeHostOverrideId ?? defaultRuntimeHostId;

  const selectedRuntime = builtinRuntimes.find(
    (r) => r.id === selectedRuntimeHostId
  );
  const selectedRuntimeType = selectedRuntime?.capabilities?.native?.available
    ? "native"
    : undefined;

  function handleRuntimeChange(runtimeHostId: string | null) {
    if (!runtimeHostId) return;
    setRuntimeHostOverrideId(runtimeHostId);
    setSelectedPath(null);
  }

  // 注入 DirectoryPicker 的目录列表函数
  const listDirectories = useMemo(() => {
    if (!selectedRuntimeHostId) return undefined;
    return async (dir: string | undefined): Promise<DirectoryListing> => {
      const res = await runtimesApi.listDirectory({
        runtimeHostId: selectedRuntimeHostId,
        path: dir,
      });
      return { path: res.path, list: res.list };
    };
  }, [selectedRuntimeHostId]);

  // 注入 DirectoryPicker 的新建目录函数
  const createDirectory = useMemo(() => {
    if (!selectedRuntimeHostId) return undefined;
    return async (path: string): Promise<string> => {
      const res = await createDirMutation.mutateAsync({
        runtimeHostId: selectedRuntimeHostId,
        path,
      });
      return res.path;
    };
  }, [selectedRuntimeHostId, createDirMutation]);

  function reset() {
    setSelectedPath(null);
    setRuntimeHostOverrideId(undefined);
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
    if (!selectedPath || !selectedRuntimeType) return;
    setError(null);

    const rootPath = normalizeFilesystemPath(selectedPath);
    const name = pathBasename(rootPath) || rootPath;
    const runtimeType = selectedRuntimeType as WorkspaceRuntimeType;

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
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>选择本地文件夹</DialogTitle>
          <DialogDescription>
            浏览并选择一个目录作为工作空间，名称自动取目录名
          </DialogDescription>
        </DialogHeader>

        {builtinRuntimes.length > 1 && (
          <Field>
            <FieldLabel htmlFor="pick-directory-runtime">运行环境</FieldLabel>
            <Select
              items={builtinRuntimes.map((runtime) => ({
                value: runtime.id,
                label: runtime.name,
              }))}
              value={selectedRuntimeHostId}
              onValueChange={handleRuntimeChange}
            >
              <SelectTrigger id="pick-directory-runtime" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {builtinRuntimes.map((runtime) => (
                  <SelectItem key={runtime.id} value={runtime.id}>
                    {runtime.name}
                    <span className="text-xs text-muted-foreground">
                      {runtimeTypeLabel(
                        runtime.capabilities?.native?.available
                          ? "native"
                          : null
                      )}
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
