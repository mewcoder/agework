import { useEffect, useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { AgentIcon } from "@/components/icons/agent";
import {
  useSelectionStore,
  type AgentType,
  type ClaudeThinkingMode,
  type ModelReasoningEffort,
} from "@/stores/selection-store";
import { useModelProviders } from "@/hooks/model-provider-hooks";
import { useAgentOptions } from "@/hooks/use-agent-options";
import { useWorkspaces } from "@/hooks/use-workspace";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { AGENT_LABELS } from "@agework/shared";

// ── Constants ──────────────────────────────────────────────────────────────

const EFFORT_LABELS: Record<ModelReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
};

const CLAUDE_THINKING_LABELS: Record<ClaudeThinkingMode, string> = {
  adaptive: "开启",
  disabled: "关闭",
};

const selectedMenuRadioClassName =
  "group/menu-radio justify-between rounded-md pl-2 pr-8 text-xs data-checked:bg-muted data-checked:font-medium [&>span:first-child]:hidden";

const menuSectionLabelClassName =
  "px-2 py-1.5 text-xs font-normal text-muted-foreground";

const triggerClassName =
  "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs select-none text-foreground transition-colors hover:bg-muted";

const agentTriggerClassName =
  "inline-flex h-7 items-center justify-center gap-0.5 rounded-md px-1.5 text-foreground transition-colors hover:bg-muted";

const menuChevronClassName = "size-3.5 shrink-0 text-muted-foreground/60";

const settingSubTriggerClassName =
  "h-8 gap-3 px-2 text-xs [&>svg:last-child]:size-4";

// ── Helpers ────────────────────────────────────────────────────────────────

function SelectedMenuCheck() {
  return (
    <CheckIcon className="absolute right-2 size-3.5 opacity-0 transition-opacity group-data-checked/menu-radio:opacity-100" />
  );
}

function getModelProviderModels(providerConfig: string) {
  try {
    const parsed = JSON.parse(providerConfig) as { models?: unknown };
    const models = Array.isArray(parsed.models) ? parsed.models : [];
    return Array.from(
      new Set(
        models
          .filter((model): model is string => typeof model === "string" && !!model.trim())
          .map((model) => model.trim()),
      ),
    );
  } catch {
    return [];
  }
}

function isSystemModelProvider(
  modelProvider: { modelProviderId: string; scope?: string } | undefined,
) {
  return modelProvider?.scope === "system";
}

// ── Agent selector ─────────────────────────────────────────────────────────

function AgentSelector() {
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const { data: agentOptions } = useAgentOptions();
  // 新对话时 agent 切换交给 composer 上方的 AgentSwitcher；这里只在已有对话
  // 显示当前 agent 的小图标提示（agent 随首条消息落库后不可更改）。
  if (selectedConversationId === undefined) return null;

  const agents = agentOptions?.list ?? [];
  const selectedAgentLabel =
    agents.find((agent) => agent.id === selectedAgentType)?.label ??
    AGENT_LABELS[selectedAgentType];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(agentTriggerClassName, "cursor-default hover:bg-transparent")}
            aria-label={`当前 Agent：${selectedAgentLabel}`}
            aria-disabled
            title={`当前 Agent：${selectedAgentLabel}`}
          >
            <AgentIcon agent={selectedAgentType} size={15} />
          </button>
        }
      />
      <TooltipContent side="top" align="end" sideOffset={6}>
        {selectedAgentLabel}
      </TooltipContent>
    </Tooltip>
  );
}

// 聊天框上方的 agent 切换按钮组：仅新对话显示，已有对话返回 null。
export function AgentSwitcher() {
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectAgentType = useSelectionStore((s) => s.selectAgentType);
  const { data: agentOptions } = useAgentOptions();
  if (selectedConversationId !== undefined) return null;

  const agents = agentOptions?.list ?? [];
  if (agents.length === 0) return null;

  const selectedIndex = Math.max(
    0,
    agents.findIndex((agent) => agent.id === selectedAgentType),
  );

  return (
    <div className="mb-2 flex justify-center">
      <ToggleGroup
        variant="default"
        size="sm"
        value={selectedAgentType ? [selectedAgentType] : []}
        onValueChange={(value) => {
          const next = value[0];
          if (next) selectAgentType(next as AgentType);
        }}
        aria-label="选择 Agent"
        className="relative !grid !gap-0 !rounded-full bg-muted"
        style={{ gridTemplateColumns: `repeat(${agents.length}, 1fr)` }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-background ring-1 ring-border transition-transform duration-200 ease-out"
          style={{
            width: `${100 / agents.length}%`,
            transform: `translateX(${selectedIndex * 100}%)`,
          }}
        />
        {agents.map((agent) => (
          <ToggleGroupItem
            key={agent.id}
            value={agent.id}
            className="relative z-10 cursor-pointer gap-1.5 !rounded-full !border-0 !bg-transparent px-3 !text-muted-foreground transition-colors hover:!bg-transparent hover:!text-foreground data-pressed:!text-foreground data-pressed:!font-medium aria-pressed:!text-foreground aria-pressed:!font-medium"
          >
            <AgentIcon agent={agent.id} size={14} />
            <span>{agent.label ?? AGENT_LABELS[agent.id]}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

// ── Model settings selector ────────────────────────────────────────────────

function ModelSettingsSelector({
  attentionMessage = "请选择模型配置",
  attentionToken = 0,
}: {
  attentionMessage?: string;
  attentionToken?: number;
}) {
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectedModelProviderIds = useSelectionStore((s) => s.selectedModelProviderIds);
  const selectedModelByProviderIds = useSelectionStore((s) => s.selectedModelByProviderIds);
  const selectModelProvider = useSelectionStore((s) => s.selectModelProvider);
  const selectModelForProvider = useSelectionStore((s) => s.selectModelForProvider);
  const setEffort = useSelectionStore((s) => s.setModelReasoningEffort);
  const effort = useSelectionStore((s) => s.modelReasoningEffort);
  const claudeThinkingMode = useSelectionStore((s) => s.claudeThinkingMode);
  const setClaudeThinkingMode = useSelectionStore((s) => s.setClaudeThinkingMode);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const { data: workspaces = [] } = useWorkspaces();
  const targetWorkspace = selectedWorkspaceId
    ? workspaces.find((w) => w.id === selectedWorkspaceId)
    : undefined;
  const runtimeId = targetWorkspace?.runtimeId ?? undefined;
  const { data: modelProviders = [], isLoading } = useModelProviders(selectedAgentType, runtimeId);
  const selectedModelProviderId = selectedModelProviderIds[selectedAgentType];
  const matchedModelProvider = modelProviders.find(
    (modelProvider) => modelProvider.modelProviderId === selectedModelProviderId,
  );
  const activeModelProvider = matchedModelProvider ?? modelProviders[0];
  const modelOptions = useMemo(
    () =>
      activeModelProvider
        ? getModelProviderModels(activeModelProvider.providerConfig)
        : [],
    [activeModelProvider],
  );
  const selectedModel = activeModelProvider
    ? selectedModelByProviderIds[activeModelProvider.modelProviderId]
    : undefined;
  const activeModel =
    selectedModel && modelOptions.includes(selectedModel)
      ? selectedModel
      : modelOptions[0];
  const isSystemProvider = isSystemModelProvider(activeModelProvider);
  const reasoningLabel = EFFORT_LABELS[effort];
  const providerSummaryLabel =
    activeModelProvider?.name ?? (isLoading ? "加载中" : "未选择");
  const modelSummaryLabel = activeModel ?? "未选择";
  const showModelInSummary = !isSystemProvider && !!activeModel;
  const showModelSection = activeModelProvider !== undefined && !isSystemProvider;
  const showReasoningSection = true;
  const summaryModelLabel =
    showModelSection && !activeModel ? "未选择" : undefined;
  const showReasoningInSummary =
    selectedAgentType === "codex" &&
    (isSystemProvider || !!activeModel);
  const triggerSummaryParts = [
    providerSummaryLabel,
    ...(summaryModelLabel ? [summaryModelLabel] : []),
    ...(showModelInSummary ? [activeModel] : []),
    ...(showReasoningInSummary ? [reasoningLabel] : []),
  ];
  const [showAttention, setShowAttention] = useState(false);

  // attentionToken 递增触发短暂高亮，引导用户去处理模型配置问题。
  useEffect(() => {
    if (attentionToken === 0) return undefined;
    queueMicrotask(() => setShowAttention(false));
    const showId = window.setTimeout(() => setShowAttention(true), 0);
    const hideId = window.setTimeout(() => setShowAttention(false), 2600);
    return () => {
      window.clearTimeout(showId);
      window.clearTimeout(hideId);
    };
  }, [attentionToken]);

  useEffect(() => {
    if (isLoading) return;
    const fallbackModelProviderId = activeModelProvider?.modelProviderId;
    const hasSelectedModelProvider =
      selectedModelProviderId !== undefined &&
      modelProviders.some((modelProvider) => modelProvider.modelProviderId === selectedModelProviderId);

    if (hasSelectedModelProvider) return;
    if (!fallbackModelProviderId && selectedModelProviderId === undefined) return;
    selectModelProvider(selectedAgentType, fallbackModelProviderId);
  }, [
    activeModelProvider?.modelProviderId,
    isLoading,
    modelProviders,
    selectModelProvider,
    selectedAgentType,
    selectedModelProviderId,
  ]);

  useEffect(() => {
    if (!activeModelProvider || isSystemProvider) return;
    const defaultModel = modelOptions[0];
    if (!defaultModel) return;
    if (selectedModel && modelOptions.includes(selectedModel)) return;
    selectModelForProvider(activeModelProvider.modelProviderId, defaultModel);
  }, [
    activeModelProvider,
    isSystemProvider,
    modelOptions,
    selectModelForProvider,
    selectedModel,
  ]);

  function handleModelProviderChange(modelProviderId: string) {
    if (modelProviderId === activeModelProvider?.modelProviderId) return;
    selectModelProvider(selectedAgentType, modelProviderId);
  }

  function handleModelChange(model: string) {
    if (!activeModelProvider || model === activeModel) return;
    selectModelForProvider(activeModelProvider.modelProviderId, model);
  }

  return (
    <DropdownMenu modal={false}>
      <Tooltip open={showAttention}>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    triggerClassName,
                    "max-w-56",
                    showAttention && "ring-1 ring-ring/30 text-foreground",
                  )}
                  aria-label="模型与推理设置"
                  title={triggerSummaryParts.join(" / ")}
                >
                  {triggerSummaryParts.map((part, index) => (
                    <span
                      key={`${part}:${index}`}
                      className={cn(
                        index === 0 ? "min-w-0 truncate" : "shrink-0",
                        index > 0 && "before:mr-1.5 before:text-muted-foreground before:content-['·']",
                      )}
                    >
                      {part}
                    </span>
                  ))}
                  <ChevronDownIcon className={menuChevronClassName} />
                </button>
              }
            />
          }
        />
        <TooltipContent side="top" align="end" sideOffset={6}>
          {attentionMessage}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-64 rounded-xl p-2 text-xs"
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className={settingSubTriggerClassName}
            disabled={isLoading}
          >
            <span className="w-10 shrink-0 font-normal text-muted-foreground">
              配置
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-foreground",
                !activeModelProvider && "text-muted-foreground",
              )}
            >
              {providerSummaryLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={8}
            alignOffset={-6}
            className="w-56 rounded-xl p-2 text-xs"
          >
            <DropdownMenuRadioGroup
              value={activeModelProvider?.modelProviderId ?? ""}
              onValueChange={handleModelProviderChange}
            >
              {modelProviders.length > 0 ? (
                modelProviders.map((modelProvider) => (
                  <DropdownMenuRadioItem
                    key={modelProvider.modelProviderId}
                    value={modelProvider.modelProviderId}
                    disabled={isLoading}
                    className={selectedMenuRadioClassName}
                  >
                    <span className="truncate">{modelProvider.name}</span>
                    <SelectedMenuCheck />
                  </DropdownMenuRadioItem>
                ))
              ) : (
                <DropdownMenuItem disabled className="text-xs">
                  无可用配置
                </DropdownMenuItem>
              )}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {showModelSection && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                className={settingSubTriggerClassName}
                disabled={modelOptions.length === 0}
              >
                <span className="w-10 shrink-0 font-normal text-muted-foreground">
                  模型
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-foreground",
                    modelOptions.length === 0 && "text-muted-foreground",
                  )}
                >
                  {modelSummaryLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                sideOffset={8}
                alignOffset={-6}
                className="w-56 rounded-xl p-2 text-xs"
              >
                <DropdownMenuRadioGroup
                  value={activeModel ?? ""}
                  onValueChange={handleModelChange}
                >
                  {modelOptions.length > 0 ? (
                    modelOptions.map((model) => (
                      <DropdownMenuRadioItem
                        key={model}
                        value={model}
                        className={selectedMenuRadioClassName}
                      >
                        <span className="truncate">{model}</span>
                        <SelectedMenuCheck />
                      </DropdownMenuRadioItem>
                    ))
                  ) : (
                    <DropdownMenuItem disabled className="text-xs">
                      无可用模型
                    </DropdownMenuItem>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}

        {showReasoningSection && (
          <>
            <DropdownMenuSeparator />
            {selectedAgentType === "claude" ? (
              <DropdownMenuRadioGroup
                value={claudeThinkingMode}
                onValueChange={(value) =>
                  setClaudeThinkingMode(value as ClaudeThinkingMode)
                }
              >
                <DropdownMenuLabel className={menuSectionLabelClassName}>
                  推理程度
                </DropdownMenuLabel>
                {(Object.entries(CLAUDE_THINKING_LABELS) as [ClaudeThinkingMode, string][]).map(
                  ([value, label]) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={value}
                      className={selectedMenuRadioClassName}
                    >
                      <span>{label}</span>
                      <SelectedMenuCheck />
                    </DropdownMenuRadioItem>
                  ),
                )}
              </DropdownMenuRadioGroup>
            ) : (
              <DropdownMenuRadioGroup
                value={effort}
                onValueChange={(value) =>
                  setEffort(value as ModelReasoningEffort)
                }
              >
                <DropdownMenuLabel className={menuSectionLabelClassName}>
                  推理程度
                </DropdownMenuLabel>
                {(Object.entries(EFFORT_LABELS) as [ModelReasoningEffort, string][]).map(
                  ([value, label]) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={value}
                      className={selectedMenuRadioClassName}
                    >
                      <span>{label}</span>
                      <SelectedMenuCheck />
                    </DropdownMenuRadioItem>
                  ),
                )}
              </DropdownMenuRadioGroup>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Agent settings controls ────────────────────────────────────────────────

export function AgentSettingsMenu({
  modelAttentionMessage,
  attentionToken = 0,
}: {
  modelAttentionMessage?: string;
  attentionToken?: number;
}) {
  return (
    <>
      <AgentSelector />
      <ModelSettingsSelector
        attentionMessage={modelAttentionMessage}
        attentionToken={attentionToken}
      />
    </>
  );
}
