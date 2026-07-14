import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { runsApi, type AdminRunDetail } from "@/api/runs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, formatDateTimeMs } from "@/utils/format";
import { cn } from "@/lib/utils";
import {
  runStatusBadgeClassName,
  runStatusLabel,
  runStatusVariant,
  statusLabel,
  statusVariant,
} from "./run-status";
import {
  formatDurationMs,
  formatInteger,
  formatRunDuration,
} from "./run-format";
import { RunEventTimeline } from "./run-event-timeline";
import { ToolCallProcessView } from "./run-tool-call";
import { RunRawEventsView } from "./run-raw-events-view";

export function RunDetailSheet({
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
                        variant={runStatusVariant(run.conversation.runStatus)}
                        className={runStatusBadgeClassName(
                          run.conversation.runStatus
                        )}
                      >
                        {runStatusLabel(run.conversation.runStatus)}
                      </Badge>
                    </div>
                    {run.conversationTitle && (
                      <span className="font-mono text-xs break-all text-muted-foreground">
                        {run.conversationId}
                      </span>
                    )}
                  </div>
                }
              />
              <DetailItem
                label="工作空间"
                value={
                  <EntityRef name={run.workspaceName} id={run.workspaceId} />
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
                  <p className="mt-2 text-sm break-words whitespace-pre-wrap text-destructive">
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

          <DetailSection title="Worker">
            <DetailGrid>
              <DetailItem label="类型" value={run.runtimeType} />
              {run.worker && (
                <>
                  <DetailItem
                    label="Worker ID"
                    value={run.worker.workerId}
                    mono
                  />
                  <DetailItem
                    label="复用范围"
                    value={
                      <Badge variant="outline">
                        {run.worker.runtimeType === "native"
                          ? "host"
                          : run.worker.scope}
                      </Badge>
                    }
                  />
                  <DetailItem
                    label="Worker 状态"
                    value={
                      <Badge
                        variant={
                          run.worker.status === "ready"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {run.worker.status}
                      </Badge>
                    }
                  />
                  <DetailItem label="Owner" value={run.worker.ownerId} mono />
                  <DetailItem
                    label="Host"
                    value={run.worker.runtimeHostId}
                    mono
                  />
                  <DetailItem
                    label="活跃 Run"
                    value={String(run.worker.runIds.length)}
                  />
                  <DetailItem
                    label="最后心跳"
                    value={formatDateTime(run.worker.lastSeenAt)}
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
                <DetailItem
                  label="轮次"
                  value={formatInteger(run.usage.numTurns)}
                />
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
          <TabsTrigger value="raw">原始事件</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col">
          <RunEventTimeline key={run.id} runId={run.id} />
        </TabsContent>
        <TabsContent value="tools" className="flex min-h-0 flex-1 flex-col">
          <ToolCallProcessView key={run.id} runId={run.id} />
        </TabsContent>
        <TabsContent value="raw" className="flex min-h-0 flex-1 flex-col">
          <RunRawEventsView key={run.id} runId={run.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
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
function EntityRef({ name, id }: { name?: string | null; id: string }) {
  const hasName = name && name !== id;
  return (
    <span className="flex min-w-0 flex-col">
      {hasName ? (
        <>
          <span className="break-words text-foreground">{name}</span>
          <span className="font-mono text-xs break-all text-muted-foreground">
            {id}
          </span>
        </>
      ) : (
        <span className="font-mono text-xs break-all text-foreground">
          {id}
        </span>
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
