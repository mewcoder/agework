import { useQuery } from "@tanstack/react-query";
import {
  runsApi,
  type AdminRunEvent,
} from "@/api/runs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";
import { formatDateTimeMs } from "@/utils/format";
import { EVENTS_FETCH_LIMIT, eventData } from "./run-events";
import { formatDurationMs } from "./run-format";

type ToolCallEntry = {
  toolCallId: string;
  toolName: string;
  startEvent: AdminRunEvent;
  resultEvent?: AdminRunEvent;
};

function aggregateToolCalls(events: AdminRunEvent[]): ToolCallEntry[] {
  const byId = new Map<string, ToolCallEntry>();
  const order: string[] = [];

  for (const event of events) {
    if (event.type === "tool.started") {
      const data = eventData(event);
      const toolCallId = event.refs?.toolCallId ?? event.targetId ?? "";
      if (!toolCallId || byId.has(toolCallId)) continue;
      const entry: ToolCallEntry = {
        toolCallId,
        toolName: String(data?.toolName ?? event.summary ?? "tool"),
        startEvent: event,
      };
      byId.set(toolCallId, entry);
      order.push(toolCallId);
    } else if (event.type === "tool.completed") {
      const toolCallId = event.refs?.toolCallId ?? event.targetId ?? "";
      if (!toolCallId) continue;
      const entry = byId.get(toolCallId);
      if (entry) entry.resultEvent = event;
    }
  }

  return order.map((id) => byId.get(id)!);
}

export function ToolCallProcessView({ runId }: { runId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "runs", "toolCalls", runId],
    queryFn: () =>
      runsApi.adminEvents({
        runId,
        typePrefix: "tool.",
        pageSize: EVENTS_FETCH_LIMIT,
      }),
  });

  const events = data?.list ?? [];
  const total = data?.total ?? 0;
  const toolCalls = aggregateToolCalls(events);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <div className="space-y-2 pr-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : isError ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载失败。
          </p>
        ) : toolCalls.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无工具调用。
          </p>
        ) : (
          <div className="flex flex-col gap-2 pr-2">
            {toolCalls.map((tc) => (
              <ToolCallCard key={tc.toolCallId} entry={tc} />
            ))}
          </div>
        )}
      </ScrollArea>
      {total > events.length && (
        <p className="shrink-0 text-center text-xs text-muted-foreground">
          仅展示最近 {events.length} 条（共 {total} 条），部分工具调用可能未显示。
        </p>
      )}
    </div>
  );
}

function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const done = !!entry.resultEvent;
  const startData = eventData(entry.startEvent);
  const resultData = entry.resultEvent ? eventData(entry.resultEvent) : null;
  const contentPreview =
    typeof resultData?.contentPreview === "string"
      ? resultData.contentPreview
      : undefined;
  const duration = done
    ? Date.parse(entry.resultEvent!.createdAt) -
      Date.parse(entry.startEvent.createdAt)
    : null;
  const state: ToolState = done ? "output-available" : "input-available";
  const output = contentPreview ?? entry.resultEvent?.summary ?? resultData;

  return (
    <Tool defaultOpen={false} className={!done ? "border-amber-500/40" : undefined}>
      <ToolHeader
        toolName={entry.toolName}
        state={state}
        meta={
          duration !== null ? (
            <span className="font-mono text-xs text-muted-foreground">
              {formatDurationMs(duration)}
            </span>
          ) : undefined
        }
      />
      <ToolContent>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            toolCallId:{" "}
            <span className="font-mono text-foreground">
              {entry.toolCallId}
            </span>
          </span>
          <span>
            开始:{" "}
            <span className="text-foreground">
              {formatDateTimeMs(entry.startEvent.createdAt)}
            </span>
          </span>
          {entry.resultEvent && (
            <span>
              结束:{" "}
              <span className="text-foreground">
                {formatDateTimeMs(entry.resultEvent.createdAt)}
              </span>
            </span>
          )}
        </div>
        <ToolOutput output={output} />
        {entry.resultEvent?.summary && entry.resultEvent.summary !== contentPreview && (
          <ToolOutput title="摘要" output={entry.resultEvent.summary} />
        )}
        <ToolInput title="Start data" input={startData} />
        <ToolOutput title="Result data" output={resultData} />
      </ToolContent>
    </Tool>
  );
}
