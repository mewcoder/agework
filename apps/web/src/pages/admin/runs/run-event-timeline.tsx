import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon } from "lucide-react";
import {
  runsApi,
  type AdminRunEvent,
  type AdminRunEventListQuery,
} from "@/api/runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTimeMs } from "@/utils/format";
import { cn } from "@/lib/utils";
import {
  EVENTS_FETCH_LIMIT,
  eventSeverity,
  eventSeverityClassName,
  eventSeverityVariant,
  type EventSeverity,
} from "./run-events";

const EVENT_ORIGIN_OPTIONS = [
  { value: "platform", label: "platform" },
  { value: "agent", label: "agent" },
  { value: "worker", label: "worker" },
];

const EVENT_ORIGIN_VALUES = EVENT_ORIGIN_OPTIONS.map((o) => o.value);

const ESTIMATED_EVENT_ROW_HEIGHT = 72;

export function RunEventTimeline({ runId }: { runId: string }) {
  // 默认全选 = 不过滤；选中子集才作为过滤条件。
  const [origin, setOrigin] = useState<string[]>(EVENT_ORIGIN_VALUES);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [eventTypeMenuOpen, setEventTypeMenuOpen] = useState(false);
  const [draftEventTypes, setDraftEventTypes] = useState<string[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "runs", "events", runId],
    queryFn: () =>
      runsApi.adminEvents({
        runId,
        origin: EVENT_ORIGIN_VALUES as AdminRunEventListQuery["origin"],
        pageSize: EVENTS_FETCH_LIMIT,
      }),
  });

  const allEvents = data?.list ?? [];
  const hasSelection = origin.length > 0;

  // 事件类型下拉的选项直接从当前运行已加载的事件聚合得到，不维护单独的枚举。
  const eventTypeOptions = useMemo(
    () => Array.from(new Set(allEvents.map((event) => event.type))).sort(),
    [allEvents]
  );

  const filteredEvents = useMemo(() => {
    return allEvents.filter((event) => {
      if (!origin.includes(event.origin)) return false;
      if (eventTypes.length > 0 && !eventTypes.includes(event.type)) return false;
      return true;
    });
  }, [allEvents, origin, eventTypes]);

  const virtualizer = useVirtualizer({
    count: filteredEvents.length,
    estimateSize: () => ESTIMATED_EVENT_ROW_HEIGHT,
    getItemKey: (index) => filteredEvents[index]!.id,
    getScrollElement: () => scrollerRef.current,
    overscan: 6,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 筛选区：事件类型多选下拉靠左，origin 靠右。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <DropdownMenu
          open={eventTypeMenuOpen}
          onOpenChange={(open) => {
            setEventTypeMenuOpen(open);
            if (open) setDraftEventTypes(eventTypes);
          }}
        >
          <DropdownMenuTrigger render={
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "gap-1",
                eventTypes.length > 0 &&
                  "border-primary/30 bg-primary/10 text-primary hover:bg-primary/15"
              )}
            >
              事件类型
              {eventTypes.length > 0 && (
                <Badge variant="secondary" className="px-1 text-[10px]">
                  {eventTypes.length}
                </Badge>
              )}
              <ChevronDownIcon className="size-3.5 text-muted-foreground" />
            </Button>
          } />
          <DropdownMenuContent
            align="start"
            className="w-60 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
          >
            {eventTypeOptions.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                暂无事件类型
              </div>
            ) : (
              <>
                <div className="max-h-72 overflow-y-auto p-1">
                  {eventTypeOptions.map((type) => (
                    <DropdownMenuCheckboxItem
                      key={type}
                      checked={draftEventTypes.includes(type)}
                      onCheckedChange={(checked) => {
                        setDraftEventTypes((prev) =>
                          checked
                            ? [...prev, type]
                            : prev.filter((selectedType) => selectedType !== type)
                        );
                      }}
                      className="font-mono text-xs"
                    >
                      <span className="min-w-0 truncate" title={type}>
                        {type}
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </div>
                <DropdownMenuSeparator className="my-0" />
                <div className="flex items-center justify-between gap-2 p-2">
                  <span className="text-xs text-muted-foreground">
                    已选 {draftEventTypes.length} 项
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={eventTypes.length === 0 && draftEventTypes.length === 0}
                      onClick={() => {
                        setDraftEventTypes([]);
                        setEventTypes([]);
                        setEventTypeMenuOpen(false);
                      }}
                    >
                      清除
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEventTypes(draftEventTypes);
                        setEventTypeMenuOpen(false);
                      }}
                    >
                      确定
                    </Button>
                  </div>
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
            <span className="mr-1 text-xs text-muted-foreground">origin</span>
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              className="flex-wrap"
              value={origin}
              onValueChange={setOrigin}
            >
              {EVENT_ORIGIN_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className="data-pressed:border-primary/40 data-pressed:bg-primary/10 data-pressed:text-primary"
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      </div>

      {/* 事件列表区域：虚拟滚动占满剩余高度；底部计数条固定贴底。 */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto pr-2">
        {!hasSelection ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            请至少选择一个 origin。
          </p>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isError ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            事件加载失败。
          </p>
        ) : filteredEvents.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            暂无事件。
          </p>
        ) : (
          <ol className="flex flex-col gap-2" style={{ paddingTop, paddingBottom }}>
            {virtualItems.map((virtualItem) => (
              <li
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
              >
                <RunEventRow event={filteredEvents[virtualItem.index]!} />
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end border-t pt-2 text-xs text-muted-foreground">
        {filteredEvents.length === allEvents.length
          ? `共 ${allEvents.length} 条`
          : `筛选出 ${filteredEvents.length} / 共 ${allEvents.length} 条`}
      </div>
    </div>
  );
}

function RunEventRow({ event }: { event: AdminRunEvent }) {
  const [showDetails, setShowDetails] = useState(false);
  const hasData = event.data !== null && event.data !== undefined;
  const hasRefs = event.refs !== null && event.refs !== undefined;
  const hasDetails = Boolean(event.summary || hasData || hasRefs);
  const severity: EventSeverity = eventSeverity(event);
  const isError = severity === "error";
  const isWarn = severity === "warn";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        !showDetails && "h-[72px]",
        isError && "border-destructive/40",
        isWarn && "border-amber-500/40"
      )}
    >
      <div className="flex">
        {/* 左侧级别色条 */}
        <div
          className={cn(
            "w-1 shrink-0",
            isError
              ? "bg-destructive/70"
              : isWarn
                ? "bg-amber-500/70"
                : "bg-border"
          )}
        />
        <div className="min-w-0 flex-1 p-3">
          {/* 第一行：事件类型 + origin + 展开按钮。 */}
          <div className="flex h-6 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-medium text-foreground">
              #{event.runSeq} {event.type}
            </span>
            <Badge
              variant={eventSeverityVariant(severity)}
              className={eventSeverityClassName(severity)}
            >
              {severity}
            </Badge>
            <Badge
              variant="outline"
              className="border-primary/25 bg-primary/5 text-primary"
            >
              {event.origin}
            </Badge>
            {event.targetType && event.targetId && (
              <Badge variant="outline" className="font-mono">
                {event.targetType}:{event.targetId}
              </Badge>
            )}
            {hasDetails && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2"
                onClick={() => setShowDetails((prev) => !prev)}
              >
                {showDetails ? "收起" : "展开"}
              </Button>
            )}
          </div>
          {/* 第二行：时间 + summary 预览。 */}
          <div className="mt-1 flex h-5 min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {formatDateTimeMs(event.createdAt)}
            </span>
            {event.summary && (
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {event.summary}
              </span>
            )}
          </div>
          {showDetails && (
            <div className="mt-3 flex flex-col gap-2 border-t pt-3">
              {event.summary && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    summary
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {event.summary}
                  </p>
                </div>
              )}
              {hasData && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    data
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {JSON.stringify(event.data, null, 2)}
                  </pre>
                </div>
              )}
              {hasRefs && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-muted-foreground">
                    refs
                  </div>
                  <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 text-xs">
                    {JSON.stringify(event.refs, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
