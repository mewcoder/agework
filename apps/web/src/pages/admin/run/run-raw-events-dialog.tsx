import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { runsApi, type AdminRunRawEvent } from "@/api/runs";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTimeMs } from "@/utils/format";

const RAW_EVENTS_FETCH_LIMIT = 1000;

export function RunRawEventsDialog({
  runId,
  open,
  onOpenChange,
  initialFilter,
}: {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时预填的关键字（如触发按钮所在事件的 toolCallId/messageId），按原文全文匹配。 */
  initialFilter?: string;
}) {
  const [filter, setFilter] = useState(initialFilter ?? "");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "runs", "raw-events", runId],
    queryFn: () =>
      runsApi.adminRawEvents({ runId, pageSize: RAW_EVENTS_FETCH_LIMIT }),
    enabled: open,
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setFilter(initialFilter ?? "");
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-3 sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle>原始流水</DialogTitle>
          <DialogDescription>
            worker 侧记录的 sdk.raw / agui.event 原文，本地按 run
            全量线性扫描，仅诊断用。
          </DialogDescription>
        </DialogHeader>

        <Input
          placeholder="按关键字过滤（如 toolCallId、messageId）"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <ScrollArea className="min-h-0 flex-1">
          {isLoading ? (
            <div className="space-y-2 pr-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : isError ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              加载失败。
            </p>
          ) : allLines.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              该 run 没有本地 raw 流水（可能未开启 trace，或已被清理）。
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
      </DialogContent>
    </Dialog>
  );
}

function RawEventLine({ line }: { line: AdminRunRawEvent }) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {line.source}
        </Badge>
        <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
          {line.name}
        </span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {formatDateTimeMs(line.ts)}
        </span>
      </div>
      <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
        {JSON.stringify(line, null, 2)}
      </pre>
    </div>
  );
}
