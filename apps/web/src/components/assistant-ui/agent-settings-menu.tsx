import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { AgentIcon } from "@/components/icons/agent";
import {
  useSelectionStore,
  type AgentType,
  type ClaudeThinkingMode,
  type ModelReasoningEffort,
} from "@/stores/selection-store";
import { useModelProviders } from "@/hooks/model-provider-hooks";
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
import { cn } from "@/lib/utils";

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

const AGENT_LABELS: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
};

const AGENT_OPTIONS: AgentType[] = ["claude", "codex"];

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

function isEnvironmentModelProvider(
  modelProvider: { modelProviderId: string; scope?: string } | undefined,
) {
  return (
    modelProvider?.scope === "environment" ||
    modelProvider?.modelProviderId.startsWith("system:")
  );
}

// ── Agent selector ─────────────────────────────────────────────────────────

function AgentSelector() {
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectAgentType = useSelectionStore((s) => s.selectAgentType);
  const canSwitchAgent = selectedConversationId === undefined;

  if (!canSwitchAgent) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(agentTriggerClassName, "cursor-default hover:bg-transparent")}
              aria-label={`当前 Agent：${AGENT_LABELS[selectedAgentType]}`}
              aria-disabled
              title={`当前 Agent：${AGENT_LABELS[selectedAgentType]}`}
            >
              <AgentIcon agent={selectedAgentType} size={15} />
            </button>
          }
        />
        <TooltipContent side="top" align="end" sideOffset={6}>
          {AGENT_LABELS[selectedAgentType]}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className={agentTriggerClassName}
            aria-label="选择 Agent"
            title={`选择 Agent：${AGENT_LABELS[selectedAgentType]}`}
            >
              <AgentIcon agent={selectedAgentType} size={15} />
              <ChevronDownIcon className={menuChevronClassName} />
            </button>
          }
        />
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-44 rounded-xl p-2 text-xs"
      >
        <DropdownMenuRadioGroup
          value={selectedAgentType}
          onValueChange={(value) => selectAgentType(value as AgentType)}
        >
          <DropdownMenuLabel className={menuSectionLabelClassName}>
            Agent
          </DropdownMenuLabel>
          {AGENT_OPTIONS.map((agent) => (
            <DropdownMenuRadioItem
              key={agent}
              value={agent}
              className={selectedMenuRadioClassName}
            >
              <span className="flex items-center gap-1.5">
                <AgentIcon agent={agent} size={14} />
                {AGENT_LABELS[agent]}
              </span>
              <SelectedMenuCheck />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const { data: modelProviders = [], isLoading } = useModelProviders(selectedAgentType);
  const selectedModelProviderId = selectedModelProviderIds[selectedAgentType];
  const matchedModelProvider = modelProviders.find(
    (modelProvider) => modelProvider.modelProviderId === selectedModelProviderId,
  );
  const activeModelProvider = matchedModelProvider ?? modelProviders[0];
  const modelOptions = activeModelProvider
    ? getModelProviderModels(activeModelProvider.providerConfig)
    : [];
  const selectedModel = activeModelProvider
    ? selectedModelByProviderIds[activeModelProvider.modelProviderId]
    : undefined;
  const activeModel =
    selectedModel && modelOptions.includes(selectedModel)
      ? selectedModel
      : modelOptions[0];
  const isEnvironmentProvider = isEnvironmentModelProvider(activeModelProvider);
  const reasoningLabel = EFFORT_LABELS[effort];
  const providerSummaryLabel =
    activeModelProvider?.name ?? (isLoading ? "加载中" : "未选择");
  const modelSummaryLabel = activeModel ?? "未选择";
  const showModelInSummary = !isEnvironmentProvider && !!activeModel;
  const showModelSection = activeModelProvider !== undefined && !isEnvironmentProvider;
  const showReasoningSection = true;
  const summaryModelLabel =
    showModelSection && !activeModel ? "未选择" : undefined;
  const showReasoningInSummary =
    selectedAgentType === "codex" &&
    (isEnvironmentProvider || !!activeModel);
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
    setShowAttention(false);
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
    if (!activeModelProvider || isEnvironmentProvider) return;
    const defaultModel = modelOptions[0];
    if (!defaultModel) return;
    if (selectedModel && modelOptions.includes(selectedModel)) return;
    selectModelForProvider(activeModelProvider.modelProviderId, defaultModel);
  }, [
    activeModelProvider,
    isEnvironmentProvider,
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
