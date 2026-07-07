import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { runsApi, type AdminRunRawEvent } from "@/api/runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTimeMs } from "@/utils/format";

const RAW_EVENTS_FETCH_LIMIT = 1000;

export function RunRawEventsView({ runId }: { runId: string }) {
  const [filter, setFilter] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "runs", "raw-events", runId],
    queryFn: () =>
      runsApi.adminRawEvents({ runId, pageSize: RAW_EVENTS_FETCH_LIMIT }),
  });

  const allLines = useMemo(() => data?.list ?? [], [data]);
  const filteredLines = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return allLines;
    return allLines.filter((line) =>
      JSON.stringify(line).toLowerCase().includes(keyword)
    );
  }, [allLines, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="shrink-0">
        <Input
          placeholder="按关键字过滤（如 toolCallId、messageId）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {isLoading ? (
          <div className="space-y-2 pr-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            加载失败。
          </p>
        ) : allLines.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            该 run 没有本地 raw 日志（可能未开启 trace，或已被清理）。
          </p>
        ) : filteredLines.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            没有匹配「{filter}」的行。
          </p>
        ) : (
          <div className="flex flex-col gap-2 pr-3">
            {filteredLines.map((line, index) => (
              <RawEventLine key={index} line={line} />
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="shrink-0 text-xs text-muted-foreground">
        {filteredLines.length === allLines.length
          ? `共 ${allLines.length} 行`
          : `筛选出 ${filteredLines.length} / 共 ${allLines.length} 行`}
      </div>
    </div>
  );
}

function RawEventLine({ line }: { line: AdminRunRawEvent }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {line.source}
        </Badge>
        <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
          {line.name}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {formatDateTimeMs(line.ts)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2"
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? "收起" : "展开"}
        </Button>
      </div>
      {expanded && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 text-xs">
          {JSON.stringify(line, null, 2)}
        </pre>
      )}
    </div>
  );
}
