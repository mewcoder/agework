import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpIcon,
  Loader2Icon,
  PencilIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/attachment";
import { AgentPermissionMenu } from "@/components/assistant-ui/agent-permission-menu";
import { AgentSettingsMenu, AgentSwitcher } from "@/components/assistant-ui/agent-settings-menu";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { WorkspaceSelector } from "@/components/workspace-selector";
import { useSelectionStore } from "@/stores/selection-store";
import { useConversations } from "@/hooks/use-conversation";
import { useModelProviders } from "@/hooks/model-provider-hooks";
import { useWorkspaces } from "@/hooks/use-workspace";
import { useAui, useAuiState, ComposerPrimitive } from "@assistant-ui/react";
import { useRuntimeUiStore, type QueuedUserInput } from "@/stores/runtime-ui-store";
import { StopConversationRunButton } from "@/components/assistant-ui/stop-conversation-run-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { labels } from "@/utils/labels";
import { isSystemModelProvider } from "@/utils/model-provider";

const EMPTY_QUEUED_INPUTS: QueuedUserInput[] = [];
const COMPOSER_SEND_BUTTON_CLASS =
  "aui-composer-send size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/85 disabled:bg-muted-foreground/20 disabled:text-muted-foreground/40";

// ── Composer action ────────────────────────────────────────────────────────

function ComposerAction({
  canSend,
  canQueue,
  showStop,
  needsWorkspace,
  needsModelProvider,
  modelProviderAttentionMessage,
  modelProviderAttentionToken,
  onRequestWorkspace,
  onRequestModelProvider,
  onQueueInput,
}: {
  canSend: boolean;
  canQueue: boolean;
  showStop: boolean;
  needsWorkspace: boolean;
  needsModelProvider: boolean;
  modelProviderAttentionMessage?: string;
  modelProviderAttentionToken: number;
  onRequestWorkspace: () => void;
  onRequestModelProvider: () => void;
  onQueueInput: () => void;
}) {
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const isRuntimeRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <div className="aui-composer-action-wrapper relative flex items-end justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <ComposerAddAttachment />
        <AgentPermissionMenu />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentSettingsMenu
          attentionToken={modelProviderAttentionToken}
          modelAttentionMessage={modelProviderAttentionMessage}
        />
        {!showStop ? (
          needsWorkspace ? (
            <Button
              type="button"
              variant="default"
              size="icon"
              className={COMPOSER_SEND_BUTTON_CLASS}
              aria-label="选择工作空间"
              disabled={!canSend}
              onClick={onRequestWorkspace}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </Button>
          ) : needsModelProvider ? (
            <Button
              type="button"
              variant="default"
              size="icon"
              className={COMPOSER_SEND_BUTTON_CLASS}
              aria-label="选择模型服务"
              disabled={!canSend}
              onClick={onRequestModelProvider}
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </Button>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className={COMPOSER_SEND_BUTTON_CLASS}
                aria-label="发送消息"
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </Button>
            </ComposerPrimitive.Send>
          )
        ) : canQueue ? (
          <Button
            type="button"
            variant="default"
            size="icon"
            className={COMPOSER_SEND_BUTTON_CLASS}
            aria-label="加入队列"
            onClick={onQueueInput}
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </Button>
        ) : isRuntimeRunning ? (
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel size-8 rounded-full"
              aria-label="停止生成"
            >
              <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        ) : (
          <StopConversationRunButton
            conversationId={selectedConversationId}
            className="aui-composer-cancel size-8 rounded-full"
            iconClassName="aui-composer-cancel-icon size-3 fill-current"
          />
        )}
      </div>
    </div>
  );
}

function QueuedInputList({
  items,
  pendingPrioritizeId,
  onPrioritize,
  onEdit,
  onRemove,
}: {
  items: QueuedUserInput[];
  pendingPrioritizeId: string | null;
  onPrioritize: (id: string) => void;
  onEdit: (item: QueuedUserInput) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mx-(--composer-radius) rounded-t-(--composer-radius) overflow-hidden border-x border-t border-border">
      {items.map((item, index) => {
        const isPrioritizing = item.id === pendingPrioritizeId;
        return (
          <div
            key={item.id}
            className={cn(
              "group/queue flex items-center gap-2 px-(--composer-padding) py-1.5 text-xs",
              index > 0 && "border-t border-border/40",
            )}
          >
            <span className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <p className="min-w-0 flex-1 truncate pr-1 text-foreground/70">
              {item.text}
            </p>
            <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <TooltipIconButton
                tooltip="立即发送"
                className="size-6"
                disabled={isPrioritizing}
                onClick={() => onPrioritize(item.id)}
              >
                {isPrioritizing ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUpIcon className="size-3.5" />
                )}
              </TooltipIconButton>
              <TooltipIconButton
                tooltip="编辑"
                className="size-6"
                onClick={() => onEdit(item)}
              >
                <PencilIcon className="size-3.5" />
              </TooltipIconButton>
              <TooltipIconButton
                tooltip="删除"
                className="size-6"
                onClick={() => onRemove(item.id)}
              >
                <Trash2Icon className="size-3.5" />
              </TooltipIconButton>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isPlainEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.nativeEvent.isComposing
  );
}

function useConversationRunning(conversationId: string | undefined) {
  const { data: conversationsData } = useConversations(undefined, "updatedAt");
  const isRuntimeRunning = useAuiState((s) => s.thread.isRunning);
  const isConversationRunning =
    conversationId !== undefined &&
    conversationsData?.conversations.find((conversation) => conversation.conversationId === conversationId)
      ?.activeRunStatus === "running";

  return isRuntimeRunning || isConversationRunning;
}

// ── Composer ───────────────────────────────────────────────────────────────

export function Composer({ onTextareaResize }: { onTextareaResize?: () => void }) {
  const aui = useAui();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectedModelProviderId = useSelectionStore(
    (s) => s.selectedModelProviderIds[s.selectedAgentType],
  );
  const newConversationFocusToken = useSelectionStore((s) => s.newConversationFocusToken);
  const canSend = useAuiState((s) => s.composer.canSend);
  const composerText = useAuiState((s) => s.composer.text);
  const activeAssistantMessageId = useAuiState((s) =>
    s.thread.messages.findLast((message) => message.role === "assistant")?.id,
  );
  const { data: workspaces = [] } = useWorkspaces();
  const { data: modelProviders = [] } = useModelProviders(selectedAgentType);
  const { data: conversationsData } = useConversations(undefined, "updatedAt");
  const selectedConversation = selectedConversationId
    ? conversationsData?.conversations.find(
        (conversation) => conversation.conversationId === selectedConversationId,
      )
    : undefined;
  const targetWorkspaceId = selectedConversation?.workspaceId ?? selectedWorkspaceId;
  const targetWorkspace = targetWorkspaceId
    ? workspaces.find((workspace) => workspace.id === targetWorkspaceId)
    : undefined;
  const selectedModelProvider = selectedModelProviderId
    ? modelProviders.find(
        (modelProvider) => modelProvider.modelProviderId === selectedModelProviderId,
      )
    : undefined;
  const needsWorkspace = !selectedConversationId && !selectedWorkspaceId;
  const needsModelProvider = !selectedModelProviderId;
  const needsNonSystemModelProvider =
    targetWorkspace?.runtimeType === "sandbox" &&
    !!selectedModelProvider &&
    isSystemModelProvider(selectedModelProvider);
  const modelProviderAttentionMessage = needsNonSystemModelProvider
    ? "沙箱工作空间不能使用系统环境模型配置"
    : "请选择模型配置";
  const queueConversationId = selectedConversationId;
  const queuedInputs = useRuntimeUiStore((s) =>
    queueConversationId
      ? s.queuedUserInputsByConversation[queueConversationId] ?? EMPTY_QUEUED_INPUTS
      : EMPTY_QUEUED_INPUTS,
  );
  const showStop = useConversationRunning(selectedConversationId);
  const [workspacePromptToken, setWorkspacePromptToken] = useState(0);
  const [modelProviderPromptToken, setModelProviderPromptToken] = useState(0);
  const [editingQueueItemId, setEditingQueueItemId] = useState<string | null>(null);
  const [pendingPrioritizeId, setPendingPrioritizeId] = useState<string | null>(null);
  const [inputAttentionActive, setInputAttentionActive] = useState(false);
  const wasRunningRef = useRef(false);

  const requestWorkspaceForSend = useCallback(() => {
    if (!canSend) return;
    setWorkspacePromptToken((token) => token + 1);
  }, [canSend]);

  const requestModelProviderForSend = useCallback(() => {
    if (!canSend) return;
    setModelProviderPromptToken((token) => token + 1);
  }, [canSend]);

  const queueCurrentInput = useCallback(() => {
    if (!queueConversationId) return;
    const text = composerText.trim();
    if (!text) return;
    useRuntimeUiStore.getState().enqueueUserInput(queueConversationId, text);
    aui.composer().setText("");
  }, [aui, composerText, queueConversationId]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (editingQueueItemId && queueConversationId) {
        event.preventDefault();
        useRuntimeUiStore.getState().updateUserInput(queueConversationId, editingQueueItemId, composerText);
        aui.composer().setText("");
        setEditingQueueItemId(null);
        return;
      }
      if (showStop) {
        event.preventDefault();
        queueCurrentInput();
        return;
      }
      if (needsWorkspace) {
        event.preventDefault();
        requestWorkspaceForSend();
        return;
      }
      if (needsModelProvider) {
        event.preventDefault();
        requestModelProviderForSend();
        return;
      }
      if (needsNonSystemModelProvider) {
        event.preventDefault();
        requestModelProviderForSend();
        return;
      }
    },
    [aui, composerText, editingQueueItemId, needsModelProvider, needsNonSystemModelProvider, needsWorkspace, queueConversationId, queueCurrentInput, requestModelProviderForSend, requestWorkspaceForSend, showStop],
  );

  const handleQueueKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape" && editingQueueItemId) {
        event.preventDefault();
        const original = queuedInputs.find((q) => q.id === editingQueueItemId);
        aui.composer().setText(original?.text ?? "");
        setEditingQueueItemId(null);
        return;
      }
      if (!isPlainEnter(event)) return;
      if (editingQueueItemId && queueConversationId) {
        event.preventDefault();
        event.stopPropagation();
        useRuntimeUiStore.getState().updateUserInput(queueConversationId, editingQueueItemId, composerText);
        aui.composer().setText("");
        setEditingQueueItemId(null);
        return;
      }
      if (!showStop) return;
      event.preventDefault();
      event.stopPropagation();
      queueCurrentInput();
    },
    [aui, composerText, editingQueueItemId, queueConversationId, queuedInputs, queueCurrentInput, showStop],
  );

  const handlePrioritizeQueuedInput = useCallback(
    (id: string) => {
      if (!queueConversationId) return;
      const runtimeUi = useRuntimeUiStore.getState();
      runtimeUi.prioritizeUserInput(queueConversationId, id);
      runtimeUi.markConversationUserSteered(queueConversationId, activeAssistantMessageId);
      setPendingPrioritizeId(id);
      const next = runtimeUi.shiftUserInput(queueConversationId);
      if (!next) return;
      window.setTimeout(() => {
        aui.thread().append(next.text);
      }, 0);
    },
    [activeAssistantMessageId, aui, queueConversationId],
  );

  const handleEditQueuedInput = useCallback(
    (item: QueuedUserInput) => {
      setEditingQueueItemId(item.id);
      aui.composer().setText(item.text);
      window.setTimeout(() => {
        inputRef.current?.focus({ preventScroll: true });
      }, 0);
    },
    [aui],
  );

  const handleRemoveQueuedInput = useCallback(
    (id: string) => {
      if (!queueConversationId) return;
      useRuntimeUiStore.getState().removeUserInput(queueConversationId, id);
    },
    [queueConversationId],
  );

  useEffect(() => {
    if (newConversationFocusToken === 0) return undefined;

    let frame = 0;
    setInputAttentionActive(false);
    const focusTimer = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      frame = window.requestAnimationFrame(() => {
        setInputAttentionActive(true);
      });
    }, 0);
    const attentionTimer = window.setTimeout(() => {
      setInputAttentionActive(false);
    }, 980);

    return () => {
      window.clearTimeout(focusTimer);
      window.clearTimeout(attentionTimer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [newConversationFocusToken]);

  // Clear editing state when AI finishes running
  useEffect(() => {
    if (!showStop && editingQueueItemId) {
      setEditingQueueItemId(null);
    }
  }, [editingQueueItemId, showStop]);

  // Clear prioritize-pending state once that item leaves the queue (dispatched or removed)
  useEffect(() => {
    if (!pendingPrioritizeId) return;
    if (queuedInputs.some((item) => item.id === pendingPrioritizeId)) return;
    setPendingPrioritizeId(null);
  }, [pendingPrioritizeId, queuedInputs]);

  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = showStop;
    if (!wasRunning || showStop || !queueConversationId) return;

    const next = useRuntimeUiStore.getState().shiftUserInput(queueConversationId);
    if (!next) return;
    window.setTimeout(() => {
      aui.thread().append(next.text);
    }, 0);
  }, [aui, queueConversationId, showStop]);

  return (
    <ComposerPrimitive.Root
      ref={formRef}
      onSubmit={handleSubmit}
      className="aui-composer-root relative flex w-full flex-col"
    >
      <AgentSwitcher />
      <div
        className={cn(
          "aui-composer-frame rounded-(--composer-radius)",
          selectedConversationId === undefined && "bg-muted/70 shadow-sm",
        )}
      >
        <QueuedInputList
          items={queuedInputs}
          pendingPrioritizeId={pendingPrioritizeId}
          onPrioritize={handlePrioritizeQueuedInput}
          onEdit={handleEditQueuedInput}
          onRemove={handleRemoveQueuedInput}
        />
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="aui_composer-shell"
            className={cn(
              "relative w-full overflow-hidden rounded-(--composer-radius) border bg-background shadow-xs transition-[border-color,background-color] duration-200 focus-within:border-border data-[dragging=true]:border-dashed data-[dragging=true]:border-ring/60 data-[dragging=true]:bg-accent/50",
              inputAttentionActive && "composer-input-attention",
            )}
          >
            <div className="flex min-h-28 w-full flex-col gap-3 p-(--composer-padding)">
              <ComposerAttachments />
              <ComposerPrimitive.Input
                ref={inputRef}
                placeholder={labels.composer.placeholder}
                className="aui-composer-input w-full resize-none bg-transparent px-1.5 py-0.5 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70"
                minRows={2}
                maxRows={10}
                onHeightChange={onTextareaResize}
                onKeyDownCapture={handleQueueKeyDownCapture}
                autoFocus
                aria-label="消息输入"
              />
              <ComposerAction
                canSend={canSend}
                canQueue={Boolean(queueConversationId && composerText.trim())}
                showStop={showStop}
                needsWorkspace={needsWorkspace}
                needsModelProvider={needsModelProvider}
                modelProviderAttentionMessage={modelProviderAttentionMessage}
                modelProviderAttentionToken={modelProviderPromptToken}
                onRequestWorkspace={requestWorkspaceForSend}
                onRequestModelProvider={requestModelProviderForSend}
                onQueueInput={queueCurrentInput}
              />
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
        {selectedConversationId === undefined && (
          <div className="aui-composer-workspace-row flex min-h-7 items-center px-2 py-2">
            <WorkspaceSelector attentionToken={workspacePromptToken} />
          </div>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}
