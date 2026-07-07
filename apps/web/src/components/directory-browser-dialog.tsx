import { useState } from "react";
import { ChevronUpIcon, FolderIcon, FolderPlusIcon, Loader2Icon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/utils/error";
import {
  useCreateRuntimeDirectory,
  useRuntimeDirectory,
} from "@/hooks/use-runtime";

interface DirectoryBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runtimeId: string | undefined;
  onSelect: (path: string) => void;
}

/** 从完整路径取最后一段作为展示名，兼容 posix / windows 分隔符。 */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** 取父目录路径（同样兼容两种分隔符）；到根目录时返回 undefined，回到默认起点。 */
function parentOf(path: string): string | undefined {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return sep === "\\" ? trimmed.slice(0, 3) || undefined : "/";
  return trimmed.slice(0, idx);
}

export function DirectoryBrowserDialog({
  open,
  onOpenChange,
  runtimeId,
  onSelect,
}: DirectoryBrowserDialogProps) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  const { data, isLoading, isError, error } = useRuntimeDirectory(
    runtimeId,
    path,
    open
  );
  const createDirectory = useCreateRuntimeDirectory();

  function reset() {
    setPath(undefined);
    setCreating(false);
    setNewFolderName("");
    createDirectory.reset();
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function handleConfirm() {
    if (!data?.path) return;
    onSelect(data.path);
    handleOpenChange(false);
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name || !runtimeId || !data?.path) return;
    const created = await createDirectory.mutateAsync({
      runtimeId,
      path: `${data.path.replace(/[/\\]+$/, "")}/${name}`,
    });
    setPath(created.path);
    setCreating(false);
    setNewFolderName("");
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>选择目录</DialogTitle>
          <DialogDescription className="truncate" title={data?.path}>
            {data?.path ?? "加载中..."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            aria-label="上一级"
            disabled={!data?.path || isLoading}
            onClick={() => setPath(parentOf(data!.path))}
          >
            <ChevronUpIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-8 shrink-0"
            aria-label="新建文件夹"
            disabled={!data?.path || isLoading}
            onClick={() => setCreating((v) => !v)}
          >
            <FolderPlusIcon className="size-4" />
          </Button>
        </div>

        {creating && (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="新文件夹名称"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreateFolder();
                }
              }}
            />
            <Button
              type="button"
              size="sm"
              disabled={!newFolderName.trim() || createDirectory.isPending}
              onClick={() => void handleCreateFolder()}
            >
              创建
            </Button>
          </div>
        )}
        {createDirectory.isError && (
          <p className="text-sm text-destructive">
            {errorMessage(createDirectory.error)}
          </p>
        )}

        <ScrollArea className="h-64 rounded-md border">
          <div className="p-1">
            {isLoading && (
              <div className="space-y-2 p-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            )}
            {isError && (
              <p className="p-3 text-sm text-destructive">
                {errorMessage(error)}
              </p>
            )}
            {data && data.list.length === 0 && (
              <p className="p-3 text-sm text-muted-foreground">
                没有子目录
              </p>
            )}
            {data?.list.map((entry) => (
              <button
                key={entry}
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => setPath(entry)}
              >
                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{basename(entry)}</span>
              </button>
            ))}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!data?.path || isLoading}
            onClick={handleConfirm}
          >
            {isLoading && <Loader2Icon className="size-4 animate-spin" />}
            选择此目录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
