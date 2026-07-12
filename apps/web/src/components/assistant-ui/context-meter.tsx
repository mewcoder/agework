import { useAuiState } from "@assistant-ui/react";
import { readAgUiCustomMetadata } from "@assistant-ui/react-ag-ui";
import {
  Context,
  ContextContent,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";

/**
 * 上下文窗口占用条：读最后一条 assistant 消息的 agui metadata（live 由 run-aggregator
 * 盖上、冷加载由 history adapter 注入，两路同一位置）。用 ai-elements 的 Context 组件
 * 渲染（圆环 + 百分比 trigger，hover 出占用明细）。无数据时不渲染。
 */
export function ContextMeter() {
  const contextUsage = useAuiState((s) => {
    const last = s.thread.messages.findLast(
      (message) => message.role === "assistant",
    );
    return readAgUiCustomMetadata(last?.metadata)?.contextUsage;
  });

  if (!contextUsage) return null;

  const rows = [
    { label: "Input", value: contextUsage.inputTokens },
    { label: "Output", value: contextUsage.outputTokens },
    { label: "Cache", value: contextUsage.cachedInputTokens },
  ].filter((row): row is { label: string; value: number } =>
    Boolean(row.value && row.value > 0),
  );

  return (
    <Context
      usedTokens={contextUsage.usedTokens}
      maxTokens={contextUsage.maxTokens}
    >
      <ContextTrigger />
      <ContextContent>
        <ContextContentHeader />
        {rows.length > 0 && (
          <div className="space-y-1.5 p-3 text-xs">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-mono tabular-nums">
                  {formatTokens(row.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </ContextContent>
    </Context>
  );
}

/** 紧凑 token 记法：K / M。 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
