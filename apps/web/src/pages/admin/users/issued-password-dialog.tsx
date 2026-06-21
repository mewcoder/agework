import { useState } from "react";
import { ClipboardIcon } from "lucide-react";
import { type PasswordIssueResponse } from "@/api/users";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTime } from "@/utils/format";
import { copyToClipboard } from "@/utils/clipboard";

export function IssuedPasswordDialog({
  result,
  onOpenChange,
}: {
  result: PasswordIssueResponse | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const open = !!result;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setCopied(false);
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>一次性密码</DialogTitle>
          <DialogDescription>
            该密码只展示本次，用户首次登录后必须修改
          </DialogDescription>
        </DialogHeader>
        {result && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border bg-muted/40 p-3 font-mono text-sm">
              {result.temporaryPassword}
            </div>
            <div className="text-sm text-muted-foreground">
              用户：{result.user.username}
              <br />
              有效期至：{formatDateTime(result.passwordExpiresAt)}
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                await copyToClipboard(result.temporaryPassword);
                setCopied(true);
              }}
            >
              <ClipboardIcon className="size-4" />
              {copied ? "已复制" : "复制密码"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
