import { useState } from "react";
import { useRenameConversation } from "@/hooks/use-conversations";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";

interface RenameConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  currentTitle: string;
}

export function RenameConversationDialog({
  open,
  onOpenChange,
  conversationId,
  currentTitle,
}: RenameConversationDialogProps) {
  const renameConversation = useRenameConversation();
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      setError("请输入标题");
      return;
    }

    // 标题没变就不调接口
    if (title.trim() === currentTitle.trim()) {
      onOpenChange(false);
      return;
    }

    renameConversation.mutate(
      { id: conversationId, title: title.trim() },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="重命名对话"
      formId="rename-conversation-form"
      isPending={renameConversation.isPending}
      submitLabel="保存"
    >
      <form id="rename-conversation-form" onSubmit={handleSubmit}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="title">标题</FieldLabel>
            <Input
              id="title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setError("");
              }}
              placeholder="输入对话标题"
              autoFocus
              onFocus={(e) => e.target.select()}
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
        </FieldGroup>
      </form>
    </FormDialog>
  );
}
