import { useState } from "react";
import { ClipboardIcon } from "lucide-react";
import type { CreateRuntimeHostResponse } from "@/hooks/use-runtime-host";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyToClipboard } from "@/utils/clipboard";
import { apiUrl } from "@/lib/http";

export function IssuedHostTokenDialog({
  result,
  onOpenChange,
}: {
  result: CreateRuntimeHostResponse | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const open = !!result;
  const serverUrl = result
    ? `${window.location.origin}${apiUrl("/api/v1")}`
    : "";
  const command = result
    ? `agework-runtime --server ${serverUrl} --token ${result.token} --runtime docker`
    : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setCopied(false);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>配对码</DialogTitle>
          <DialogDescription>
            该配对码只展示本次，请立即在目标机器上运行下面的命令完成配对
          </DialogDescription>
        </DialogHeader>
        {result && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm break-all">
              {command}
            </div>
            <div className="text-sm text-muted-foreground">
              机器：{result.runtimeHost.name}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                await copyToClipboard(command);
                setCopied(true);
              }}
            >
              <ClipboardIcon className="size-4" />
              {copied ? "已复制" : "复制命令"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
