import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
} from "lucide-react";
import {
  runsApi,
  type AdminRun,
  type AdminRunDetail,
  type AdminRunEvent,
  type AdminRunEventListQuery,
  type RunStatus,
} from "@/api/runs";
import {
  DataTable,
  DataTableBadge,
  DataTableButton,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime, formatDateTimeMs } from "@/utils/format";
import { usePagination } from "@/hooks/use-pagination";
import { PaginationBar } from "@/components/pagination-bar";
import { cn } from "@/lib/utils";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "@/components/ai-elements/tool";

const STATUS_OPTIONS: { value: RunStatus | "all"; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "queued", label: "排队中" },
  { value: "preparing", label: "准备中" },
  { value: "requires_action", label: "等待操作" },
  { value: "cancelling", label: "取消中" },
  { value: "finished", label: "已完成" },
  { value: "error", label: "出错" },
  { value: "cancelled", label: "已取消" },
];

const INTEGER_FORMATTER = new Intl.NumberFormat("zh-CN");

function statusLabel(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function statusVariant(status: string) {
  if (status === "error") return "destructive" as const;
  if (status === "finished") return "secondary" as const;
  if (status === "running" || status === "requires_action")
    return "default" as const;
  return "outline" as const;
}

function activeRunStatusLabel(status: string) {
  if (status === "idle") return "空闲";
  if (status === "running") return "运行中";
  if (status === "error") return "出错";
  return status;
}

function activeRunStatusVariant(status: string) {
  if (status === "error") return "destructive" as const;
  if (status === "running") return "default" as const;
  return "secondary" as const;
}

function runStatusBadgeClassName(status: string) {
  if (status === "error") return undefined;
  if (status === "running" || status === "requires_action") {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  if (status === "finished") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  if (status === "cancelled" || status === "cancelling") {
    return "border-muted-foreground/30 bg-muted text-muted-foreground";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700";
}

function activeRunStatusBadgeClassName(status: string) {
  if (status === "error") return undefined;
  if (status === "running") {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}

export function RunsPanel({ showHeader = true }: { showHeader?: boolean }) {
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { pageNo, pageSize, goPrev, goNext, setPageNo } = usePagination();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "runs", status, pageNo],
    queryFn: () =>
      runsApi.adminList({
        status: status === "all" ? undefined : status,
        pageNo,
        pageSize,
      }),
  });

  const items: AdminRun[] = data?.list ?? [];
  const total = data?.total ?? 0;

  const columns: DataTableColumnDef<AdminRun>[] = [
    {
      id: "conversation",
      header: "对话",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => {
        const run = row.original;

        return (
          <DataTableText
            className="font-medium"
            title={run.conversationTitle ?? run.conversationId}
          >
            {run.conversationTitle || run.conversationId}
          </DataTableText>
        );
      },
    },
    {
      id: "user",
      header: "用户",
      cell: ({ row }) =>
        row.original.username ? (
          <DataTableText>{row.original.username}</DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: "agent",
      header: "Agent",
      cell: ({ row }) => <DataTableText>{row.original.agentType}</DataTableText>,
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => {
        const run = row.original;

        return run.error ? (
          <Tooltip>
            <TooltipTrigger render={
              <DataTableBadge
                variant={statusVariant(run.status)}
                className="cursor-default gap-1"
              >
                <CircleAlertIcon />
                {statusLabel(run.status)}
              </DataTableBadge>
            } />
            <TooltipContent className="max-w-xs whitespace-pre-wrap">
              {run.error}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DataTableBadge variant={statusVariant(run.status)}>
            {statusLabel(run.status)}
          </DataTableBadge>
        );
      },
    },
    {
      id: "finishedAt",
      header: "结束时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.finishedAt)}</DataTableText>,
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => (
        <DataTableButton
          variant="ghost"
          onClick={() => setSelectedRunId(row.original.id)}
        >
          <EyeIcon data-icon="inline-start" />
          详情
        </DataTableButton>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">运行记录</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            查看所有用户的 Agent 运行记录
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as RunStatus | "all");
            setPageNo(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={items}
        isLoading={isLoading}
        emptyText="暂无运行记录"
        getRowId={(run) => run.id}
      />

      <PaginationBar
        pageNo={pageNo}
        pageSize={pageSize}
        total={total}
        onPrev={() => goPrev(total)}
        onNext={() => goNext(total)}
      />

      <RunDetailSheet
        runId={selectedRunId}
        open={selectedRunId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
      />
    </div>
  );
}

function RunDetailSheet({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isError, isLoading } = useQuery({
    queryKey: ["admin", "runs", "detail", runId],
    queryFn: () => {
      if (!runId) throw new Error("missing run id");
      return runsApi.adminQuery(runId);
    },
    enabled: open && Boolean(runId),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="gap-0"
        style={{ width: "100vw", maxWidth: "none" }}
      >
        <SheetHeader className="border-b py-3">
          <SheetTitle>运行详情</SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <RunDetailSkeleton />
        ) : isError || !data ? (
          <div className="p-4 text-sm text-muted-foreground">
            运行详情加载失败
          </div>
        ) : (
          <RunDetailContent run={data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function RunDetailContent({ run }: { run: AdminRunDetail }) {
  const [showRunError, setShowRunError] = useState(false);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-hidden p-4 md:p-6 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
      {/* 左栏：元信息卡片纵向堆叠，自身可滚动 */}
      <ScrollArea className="min-h-0">
        <div className="flex flex-col gap-6 pr-2">
          <DetailSection title="基本信息">
            <DetailGrid>
              <DetailItem
                label="runId"
                value={
                  <span className="inline-flex items-center gap-2">
                    <span>{run.id}</span>
                    <Badge
                      variant={statusVariant(run.status)}
                      className={runStatusBadgeClassName(run.status)}
                    >
                      {statusLabel(run.status)}
                    </Badge>
                  </span>
                }
                mono
              />
              {run.phase && <DetailItem label="Phase" value={run.phase} />}
              <DetailItem
                label="对话"
                value={
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="break-words text-foreground">
                        {run.conversationTitle || run.conversationId}
                      </span>
                      <Badge
                        variant={activeRunStatusVariant(run.conversation.activeRunStatus)}
                        className={activeRunStatusBadgeClassName(
                          run.conversation.activeRunStatus
                        )}
                      >
                        {activeRunStatusLabel(run.conversation.activeRunStatus)}
                      </Badge>
                    </div>
                    {run.conversationTitle && (
                      <span className="break-all font-mono text-xs text-muted-foreground">
                        {run.conversationId}
                      </span>
                    )}
                  </div>
                }
              />
              <DetailItem
                label="工作空间"
                value={
                  <EntityRef
                    name={run.workspaceName}
                    id={run.workspaceId}
                  />
                }
              />
              <DetailItem
                label="用户"
                value={<EntityRef name={run.username} id={run.userId} />}
              />
              <DetailItem label="agent" value={run.agentType} />
              <DetailItem
                label="agentSessionId"
                value={run.conversation.agentSessionId}
                mono
              />
            </DetailGrid>

            {run.error && (
              <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-destructive">
                    错误信息
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowRunError((prev) => !prev)}
                  >
                    {showRunError ? "收起" : "展开"}
                  </Button>
                </div>
                {showRunError && (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-destructive">
                    {run.error}
                  </p>
                )}
              </div>
            )}
          </DetailSection>

          <DetailSection title="时间">
            <DetailGrid>
              <DetailItem
                label="创建时间"
                value={formatDateTimeMs(run.createdAt)}
              />
              <DetailItem
                label="开始时间"
                value={formatDateTimeMs(run.startedAt)}
              />
              <DetailItem
                label="最近心跳"
                value={formatDateTimeMs(run.lastHeartbeatAt)}
              />
              <DetailItem
                label="结束时间"
                value={formatDateTimeMs(run.finishedAt)}
              />
              <DetailItem
                label="总耗时"
                value={formatRunDuration(run.createdAt, run.finishedAt)}
              />
              <DetailItem
                label="API 耗时"
                value={formatDurationMs(run.usage?.durationApiMs)}
              />
            </DetailGrid>
          </DetailSection>

          <DetailSection title="执行环境">
            <DetailGrid>
              <DetailItem label="类型" value={run.runtimeType} />
              {run.runtimeResource && (
                <>
                  <DetailItem
                    label="Resource ID"
                    value={run.runtimeResource.id}
                    mono
                  />
                  <DetailItem
                    label="隔离粒度"
                    value={
                      <Badge variant="outline">
                        {run.runtimeResource.isolationScope}
                      </Badge>
                    }
                  />
                  <DetailItem
                    label="资源状态"
                    value={
                      <Badge
                        variant={statusVariant(run.runtimeResource.status)}
                        className={runStatusBadgeClassName(run.runtimeResource.status)}
                      >
                        {run.runtimeResource.status}
                      </Badge>
                    }
                  />
                  <DetailItem
                    label="Owner User"
                    value={run.runtimeResource.ownerUserId}
                    mono
                  />
                  <DetailItem
                    label="Owner Workspace"
                    value={run.runtimeResource.ownerWorkspaceId}
                    mono
                  />
                  <DetailItem
                    label="绑定工作空间"
                    value={String(run.runtimeResource.workspaceRuntimes.length)}
                  />
                  <DetailItem
                    label="过期时间"
                    value={formatDateTime(run.runtimeResource.expiresAt)}
                  />
                </>
              )}
            </DetailGrid>
          </DetailSection>

          <DetailSection title="用量">
            {run.usage ? (
              <DetailGrid>
                <DetailItem
                  label="输入 tokens"
                  value={formatInteger(run.usage.inputTokens)}
                />
                <DetailItem
                  label="输出 tokens"
                  value={formatInteger(run.usage.outputTokens)}
                />
                <DetailItem
                  label="缓存输入"
                  value={formatInteger(run.usage.cachedInputTokens)}
                />
                <DetailItem
                  label="缓存创建"
                  value={formatInteger(run.usage.cacheCreationInputTokens)}
                />
                <DetailItem
                  label="推理输出"
                  value={formatInteger(run.usage.reasoningOutputTokens)}
                />
                <DetailItem label="轮次" value={formatInteger(run.usage.numTurns)} />
              </DetailGrid>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无 token 用量记录。
              </p>
            )}
          </DetailSection>
        </div>
      </ScrollArea>

      {/* 右栏：事件 / 工具调用切换。 */}
      <Tabs defaultValue="timeline" className="flex min-h-0 flex-col">
        <TabsList variant="line" className="shrink-0">
          <TabsTrigger value="timeline">事件</TabsTrigger>
          <TabsTrigger value="tools">工具调用</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col">
          <RunEventTimeline key={run.id} runId={run.id} />
        </TabsContent>
        <TabsContent value="tools" className="flex min-h-0 flex-1 flex-col">
          <ToolCallProcessView key={run.id} runId={run.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const EVENT_ORIGIN_OPTIONS = [
  { value: "platform", label: "platform" },
  { value: "agent", label: "agent" },
  { value: "worker", label: "worker" },
];

const EVENT_ORIGIN_VALUES = EVENT_ORIGIN_OPTIONS.map((o) => o.value);

// 单次 run 的事件数量天然有上限，一次性取全量后在前端筛选 + 虚拟滚动，不再分页。
const EVENTS_FETCH_LIMIT = 5000;
const ESTIMATED_EVENT_ROW_HEIGHT = 72;

function RunEventTimeline({ runId }: { runId: string }) {
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
  const severity = eventSeverity(event);
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

function ToolCallProcessView({ runId }: { runId: string }) {
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

type EventSeverity = "info" | "warn" | "error";

function eventData(event: AdminRunEvent): Record<string, unknown> | null {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
}

function eventSeverity(event: AdminRunEvent): EventSeverity {
  const data = eventData(event);
  if (event.type.endsWith(".failed")) return "error";
  if (event.type === "system.issue" && data?.severity === "error") return "error";
  if (event.type === "system.issue") return "warn";
  if (event.type === "run.status_changed" && data?.status === "error") {
    return "error";
  }
  return "info";
}

function eventSeverityVariant(severity: EventSeverity) {
  if (severity === "error") return "destructive" as const;
  if (severity === "warn") return "secondary" as const;
  return "outline" as const;
}

function eventSeverityClassName(severity: EventSeverity) {
  if (severity === "error") return undefined;
  if (severity === "warn") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700";
}

function formatInteger(value?: number | null) {
  return typeof value === "number" ? INTEGER_FORMATTER.format(value) : "-";
}

function RunDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function DetailGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[120px_minmax(0,1fr)]",
        className
      )}
    >
      {children}
    </dl>
  );
}

/** 关联实体：名称为主，ID 作为 mono 小字辅助显示。 */
function EntityRef({
  name,
  id,
}: {
  name?: string | null;
  id: string;
}) {
  const hasName = name && name !== id;
  return (
    <span className="flex min-w-0 flex-col">
      {hasName ? (
        <>
          <span className="break-words text-foreground">{name}</span>
          <span className="break-all font-mono text-xs text-muted-foreground">
            {id}
          </span>
        </>
      ) : (
        <span className="break-all font-mono text-xs text-foreground">{id}</span>
      )}
    </span>
  );
}

function DetailItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  const empty = value === null || value === undefined || value === "";
  const title = typeof value === "string" ? value : undefined;

  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-foreground",
          mono && "font-mono text-xs"
        )}
        title={title}
      >
        {empty ? "-" : value}
      </dd>
    </>
  );
}

function formatRunDuration(
  startedAt?: string | null,
  finishedAt?: string | null
): string {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "-";

  return formatDurationMs(end - start);
}

/** 毫秒 → 可读时长（与总耗时同风格）。 */
function formatDurationMs(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  if (seconds > 0) return `${seconds}秒`;
  return `${Math.floor(ms)}毫秒`;
}
