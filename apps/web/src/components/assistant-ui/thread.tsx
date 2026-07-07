import {
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ThreadWelcome } from "@/components/assistant-ui/thread-welcome";
import { Composer } from "@/components/assistant-ui/thread-composer";
import { PendingQuestionPanel } from "@/components/assistant-ui/pending-question-panel";
import { AssistantMessage } from "@/components/assistant-ui/assistant-message";
import { UserMessage, EditComposer } from "@/components/assistant-ui/user-message";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useSelectionStore } from "@/stores/selection-store";
import { useRuntimeUiStore } from "@/stores/runtime-ui-store";
import { parseSseSnapshots, normalizeResumeSnapshot } from "@/lib/runtime/thread-history-adapter";
import {
  dropStalePendingQuestionMessage,
  needsManualResumeReconnect,
  toExportedMessageRepository,
  type ExportedMessageRepositoryLike,
} from "@/lib/runtime/pending-question-resume";
import { apiUrl } from "@/lib/http";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import type { ChatModelRunResult } from "@assistant-ui/react";

// 这里没有用 ThreadPrimitive.Viewport：它不支持消息列表虚拟化（一次性渲染全部
// 消息），长对话下会有明显的渲染/滚动开销，所以改成 @tanstack/react-virtual 自己
// 管理滚动容器。贴底/自动滚动这部分行为参考了 reference-source-code/assistant-ui/
// packages/react/src/primitives/thread/useThreadViewportAutoScroll.ts 的实现
// （isAtBottom 判定、scrollHeight 不变时才认定为"用户主动上滚"等），按虚拟化场景
// 重新实现，而不是简单复用——原实现假设全部消息都在 DOM 里，没有这里的按需渲染。
const ESTIMATED_TURN_HEIGHT = 220;
const AT_BOTTOM_THRESHOLD = 4;
const NAVIGATION_ACTIVE_TOP_SLOP = 8;

type MessageComponents = ComponentProps<
  typeof ThreadPrimitive.MessageByIndex
>["components"];

type Turn = {
  id: string;
  indices: number[];
};

type MessageNavigationItem = {
  id: string;
  index: number;
  turnIndex: number;
  label: string;
};

const MESSAGE_COMPONENTS: MessageComponents = {
  UserMessage,
  AssistantMessage,
  UserEditComposer: EditComposer,
  AssistantEditComposer: EditComposer,
};

const COMPOSER_LAYOUT_TRANSITION = {
  duration: 130,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
};
const COMPOSER_LAYOUT_MAX_OFFSET = 18;

function buildTurns(messages: readonly { id: string; role: string }[]): Turn[] {
  const turns: Turn[] = [];
  for (let index = 0; index < messages.length; index++) {
    const { id, role } = messages[index]!;
    const last = turns.at(-1);
    if (role === "user" || !last) turns.push({ id, indices: [index] });
    else last.indices.push(index);
  }

  return turns;
}

function messagePreviewText(message: { parts?: unknown; content?: unknown }) {
  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : [];
  const text = parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return text || "用户消息";
}

function buildNavigationItems(
  messages: readonly { id: string; role: string; parts?: unknown; content?: unknown }[],
  turns: readonly Turn[],
): MessageNavigationItem[] {
  const turnIndexByMessageIndex = new Map<number, number>();
  turns.forEach((turn, turnIndex) => {
    turn.indices.forEach((messageIndex) => {
      turnIndexByMessageIndex.set(messageIndex, turnIndex);
    });
  });

  return messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const turnIndex = turnIndexByMessageIndex.get(index);
    if (turnIndex === undefined) return [];
    return [
      {
        id: message.id,
        index,
        turnIndex,
        label: messagePreviewText(message),
      },
    ];
  });
}

function resolveActiveNavigationIndex(
  items: readonly MessageNavigationItem[],
  getTurnStart: (turnIndex: number) => number | undefined,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
) {
  if (items.length === 0) return -1;
  if (scrollTop <= NAVIGATION_ACTIVE_TOP_SLOP) return 0;
  if (
    scrollHeight > 0 &&
    clientHeight > 0 &&
    scrollTop + clientHeight >= scrollHeight - AT_BOTTOM_THRESHOLD
  ) {
    return items.length - 1;
  }

  const anchor = scrollTop + NAVIGATION_ACTIVE_TOP_SLOP;
  let activeIndex = 0;
  for (let index = 0; index < items.length; index++) {
    const turnStart = getTurnStart(items[index]!.turnIndex);
    if (turnStart === undefined) continue;
    if (turnStart > anchor) break;
    activeIndex = index;
  }

  return activeIndex;
}

function useLayoutShiftAnimation<T extends HTMLElement>(
  dependencies: readonly unknown[],
) {
  const ref = useRef<T | null>(null);
  const previousRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const nextRect = el.getBoundingClientRect();
    const previousRect = previousRectRef.current;
    previousRectRef.current = nextRect;

    if (
      !previousRect ||
      (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      return;
    }

    const deltaX = previousRect.left - nextRect.left;
    const deltaY = previousRect.top - nextRect.top;
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

    const visualDeltaX =
      Math.sign(deltaX) * Math.min(Math.abs(deltaX), COMPOSER_LAYOUT_MAX_OFFSET);
    const visualDeltaY =
      Math.sign(deltaY) * Math.min(Math.abs(deltaY), COMPOSER_LAYOUT_MAX_OFFSET);

    animationRef.current?.cancel();
    animationRef.current = el.animate(
      [
        {
          opacity: 0.96,
          transform: `translate3d(${visualDeltaX}px, ${visualDeltaY}px, 0)`,
        },
        { opacity: 1, transform: "translate3d(0, 0, 0)" },
      ],
      COMPOSER_LAYOUT_TRANSITION,
    );
  }, dependencies); // eslint-disable-line react-hooks/exhaustive-deps

  return ref;
}

function ThreadMessageNavigator({
  items,
  activeIndex,
  onSelect,
}: {
  items: readonly MessageNavigationItem[];
  activeIndex: number;
  onSelect: (item: MessageNavigationItem) => void;
}) {
  if (items.length < 2) return null;

  return (
    <div className="group/thread-nav absolute right-3 top-1/2 z-20 hidden max-h-[calc(100%-8rem)] -translate-y-1/2 items-center justify-end md:flex">
      <div className="flex max-h-full w-7 justify-end overflow-y-auto overscroll-contain py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex flex-col items-end gap-1">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-label={`跳转到第 ${index + 1} 条用户消息`}
              onClick={() => onSelect(item)}
              className="group/nav-tick flex h-2 w-7 items-center justify-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span
                className={cn(
                  "h-0.5 w-4 rounded-[999px] bg-muted-foreground/40 transition-colors group-hover/thread-nav:bg-muted-foreground/50 group-hover/nav-tick:bg-foreground group-focus-visible/nav-tick:bg-foreground",
                  index === activeIndex && "bg-foreground",
                )}
              />
            </button>
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute right-7 top-1/2 w-[min(20rem,calc(100vw-5rem))] -translate-y-1/2 translate-x-1 opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/thread-nav:pointer-events-auto group-hover/thread-nav:-translate-y-1/2 group-hover/thread-nav:translate-x-0 group-hover/thread-nav:opacity-100 group-focus-within/thread-nav:pointer-events-auto group-focus-within/thread-nav:-translate-y-1/2 group-focus-within/thread-nav:translate-x-0 group-focus-within/thread-nav:opacity-100">
        <div className="max-h-[min(36rem,calc(100vh-7rem))] overflow-y-auto rounded-2xl border border-border/80 bg-background/95 p-2 shadow-lg backdrop-blur-md">
          <div className="flex flex-col gap-1">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item)}
                className={cn(
                  "min-h-8 w-full rounded-xl px-3 py-1.5 text-left text-sm leading-6 text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                  index === activeIndex && "bg-muted",
                )}
              >
                <span className="line-clamp-1">{item.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Thread() {
  const aui = useAui();
  // 只用 length + 最后一条消息 id 拼成的指纹做变更检测：流式输出期间只有最后一条
  // 消息的内容在变，id/role 不变，这个指纹保持不变，避免每个 token 都触发一次
  // O(n) 的全量遍历。指纹一旦变化（消息数变化、或换了一条不同 id 的最后消息——
  // 包括切分支），才去重新读取完整消息列表重建 turns。
  const messagesFingerprint = useAuiState((s) => {
    const messages = s.thread.messages;
    const last = messages[messages.length - 1];
    return `${messages.length}:${last ? String(last.id) : ""}`;
  });
  // messagesFingerprint 不会出现在下面回调体里——它只是廉价的变更检测 key，
  // 真正的消息列表是通过 aui 命令式读取的，因此故意放进依赖数组触发重算。
  const turns = useMemo(
    () => buildTurns(aui.thread().getState().messages),
    [messagesFingerprint, aui], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const composerLayoutRef = useLayoutShiftAnimation<HTMLDivElement>([
    isEmpty,
    mainThreadId,
  ]);

  // 刷新后在 requires_action 状态下回答了 pending question 时，前端没有 SSE 连接，
  // worker 继续执行的事件收不到。检测到标记后，直接在当前 runtime 上调用
  // resumeRun，建立新的 resume SSE 连接把后续事件接上，不 reload 页面。
  const pendingQuestionReplied = useRuntimeUiStore((s) =>
    selectedConversationId
      ? s.pendingQuestionRepliedConversations.has(selectedConversationId)
      : false,
  );
  useEffect(() => {
    if (!pendingQuestionReplied || !selectedConversationId) return;
    // 注意：不在这里 consume，等 resumeRun 真正发起后再 consume，
    // 避免 resumeRun 失败时标记丢失、后续无法重试。

    // 短暂延迟让后端处理 reply（worker resolve + emitPendingAction(null) + run 变 running）。
    const timer = setTimeout(() => {
      void (async () => {
        // 没刷新页面时，原始 /agent/run 的 SSE 连接仍然存活，worker resolve 后的
        // 续接事件会通过它正常到达——不需要、也不能再手动 resumeRun，否则会和正在
        // 进行的原始 run 同时各建一条助手消息，出现两个"正在处理"。
        if (!needsManualResumeReconnect(aui.thread().getState().isRunning)) {
          useRuntimeUiStore
            .getState()
            .consumePendingQuestionReplied(selectedConversationId);
          return;
        }

        const threadRuntime = (
          aui as unknown as {
            thread: () => {
              __internal_getRuntime?: () => {
                resumeRun?: (config: {
                  parentId: string | null;
                  stream?: (
                    options: unknown,
                  ) => AsyncGenerator<ChatModelRunResult, void, unknown>;
                }) => void;
                import?: (
                  data: ExportedMessageRepositoryLike<unknown>,
                ) => void;
              };
            };
          }
        )
          .thread()
          .__internal_getRuntime?.();

        if (!threadRuntime?.resumeRun) {
          console.warn("[Thread] resumeRun not available, falling back to reload");
          useRuntimeUiStore
            .getState()
            .consumePendingQuestionReplied(selectedConversationId);
          window.location.reload();
          return;
        }

        const token = useAuthStore.getState().token;
        // 旧的 pending-question 消息还停在 status=running——resumeRun 会无条件
        // 新建一条占位 assistant 消息，两者都 running 会变成重复的"正在处理"，
        // 且旧消息永远不会再更新。续接前先把它从消息列表里去掉。
        const { messages: liveMessages, removed } =
          dropStalePendingQuestionMessage(aui.thread().getState().messages);
        if (removed) {
          threadRuntime.import?.(toExportedMessageRepository(liveMessages));
        }
        const parentId = liveMessages.at(-1)?.id ?? null;

        try {
          threadRuntime.resumeRun({
            parentId,
            stream: async function* () {
              const res = await fetch(
                apiUrl(
                  `/api/v1/agent/resume?id=${selectedConversationId}`
                ),
                {
                  headers: {
                    Accept: "text/event-stream",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                  },
                },
              );
              // 409 = 仍在 requires_action（后端还没处理完 reply）/ 404 = 无活跃 run
              if (!res.ok || !res.body) {
                console.warn("[Thread] resume returned", res.status);
                return;
              }
              for await (const result of parseSseSnapshots(res.body)) {
                yield normalizeResumeSnapshot(result);
              }
            },
          });
          // resumeRun 已成功发起，消费标记
          useRuntimeUiStore
            .getState()
            .consumePendingQuestionReplied(selectedConversationId);
        } catch (err) {
          console.error("[Thread] resumeRun failed:", err);
          useRuntimeUiStore
            .getState()
            .consumePendingQuestionReplied(selectedConversationId);
        }
      })();
    }, 500);
    return () => clearTimeout(timer);
  }, [pendingQuestionReplied, selectedConversationId, aui]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [viewportMetrics, setViewportMetrics] = useState({
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  });

  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => turns[index]!.id,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 4,
    scrollToFn: (offset, options, instance) => {
      const el = instance.scrollElement;
      if (!el) return;
      if (stickyRef.current) {
        // 贴底时不能只"原地不动"——虚拟化器测量到的尺寸在快速流式输出时会滞后于
        // 真实 DOM 高度，如果只是跳过、不主动追到当前真实底部，scrollTop 会卡在
        // 旧位置，缺口随内容持续增长越拉越大。这里直接以当前真实 scrollHeight 为
        // 准，而不是用虚拟化器算出来的（可能滞后的）offset。
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (offset < maxScroll) {
          el.scrollTop = maxScroll;
          return;
        }
      }
      el.scrollTo({ top: offset, behavior: options.behavior });
    },
  });

  const updateViewportMetrics = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setViewportMetrics((prev) => {
      const next = {
        scrollTop: Math.round(el.scrollTop),
        clientHeight: Math.round(el.clientHeight),
        scrollHeight: Math.round(el.scrollHeight),
      };
      if (
        prev.scrollTop === next.scrollTop &&
        prev.clientHeight === next.clientHeight &&
        prev.scrollHeight === next.scrollHeight
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  // 自动触发（流式贴底、切换会话、运行开始）必须瞬间到位——这些是高频/被动
  // 触发的维持性操作，做成动画会互相打架，体感就是"卡/慢"。
  const jumpToBottom = useCallback(() => {
    stickyRef.current = true;
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    }
    requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (el && stickyRef.current) {
        el.scrollTop = el.scrollHeight;
        updateViewportMetrics();
      }
    });
  }, [turns.length, updateViewportMetrics, virtualizer]);

  // 用户主动点击"滚动到底部"按钮则是一次性操作，用平滑动画体验更好。
  const scrollToBottomSmooth = useCallback(() => {
    stickyRef.current = true;
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const navigationItems = useMemo(
    () => buildNavigationItems(aui.thread().getState().messages, turns),
    [messagesFingerprint, turns, aui], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateViewportMetrics();

    let lastScrollTop = el.scrollTop;
    let lastScrollHeight = el.scrollHeight;
    let lastClientHeight = el.clientHeight;

    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
      if (atBottom) {
        stickyRef.current = true;
      } else if (
        el.scrollTop < lastScrollTop &&
        el.scrollHeight === lastScrollHeight &&
        Math.abs(el.clientHeight - lastClientHeight) <= 1
      ) {
        stickyRef.current = false;
      }

      lastScrollTop = el.scrollTop;
      lastScrollHeight = el.scrollHeight;
      lastClientHeight = el.clientHeight;
      setIsAtBottom(atBottom);
      updateViewportMetrics();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stickyRef.current = false;
    };
    const disarm = () => {
      stickyRef.current = false;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", disarm, { passive: true });

    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", disarm);
    };
  }, [updateViewportMetrics]);

  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    // 流式输出期间每个 token 都可能触发一次 ResizeObserver，这里记录上次观察到的
    // 尺寸——没有真正变化就跳过强制贴底，避免每次回调都白做一次 scrollHeight 读
    // + scrollTop 写（强制重排）。
    let lastObservedScrollHeight = el.scrollHeight;
    let lastObservedClientHeight = el.clientHeight;

    const observer = new ResizeObserver(() => {
      const { scrollHeight, clientHeight } = el;
      if (
        scrollHeight === lastObservedScrollHeight &&
        clientHeight === lastObservedClientHeight
      ) {
        return;
      }
      lastObservedScrollHeight = scrollHeight;
      lastObservedClientHeight = clientHeight;
      if (stickyRef.current) el.scrollTop = scrollHeight;
      updateViewportMetrics();
    });
    // 同时监听 content 和 scroller：content 变化是消息增长，scroller 变化是 footer
    // 增高（textarea 自动变行）导致可视区域缩小。两者都需要贴底维持。
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [updateViewportMetrics]);

  // 后台会话在 / ↔ /c/$conversationId 间常驻挂载（见 workbench.tsx），同一个
  // Thread 实例会被多个会话复用，所以"是否已经跳过底部"要按 mainThreadId 记录，
  // 而不能用一次性的 ref——否则切换会话后不会重新跳到新会话的底部。
  const lastJumpedThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (turns.length === 0 || lastJumpedThreadIdRef.current === mainThreadId) return;
    lastJumpedThreadIdRef.current = mainThreadId;
    jumpToBottom();
  }, [mainThreadId, turns.length, jumpToBottom]);

  // 同理，"运行开始时跳到底部"的上一次状态也要按 mainThreadId 记录，否则从一个
  // 运行中的会话切到另一个运行中的会话时，isRunning 始终是 true，检测不到"开始"。
  const runningThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (isRunning) {
      if (runningThreadIdRef.current !== mainThreadId) jumpToBottom();
      runningThreadIdRef.current = mainThreadId;
    } else {
      runningThreadIdRef.current = null;
    }
  }, [isRunning, mainThreadId, jumpToBottom]);

  const items = virtualizer.getVirtualItems();
  const activeNavigationIndex = useMemo(() => {
    return resolveActiveNavigationIndex(
      navigationItems,
      (turnIndex) => virtualizer.getOffsetForIndex(turnIndex, "start")?.[0],
      viewportMetrics.scrollTop,
      viewportMetrics.clientHeight,
      viewportMetrics.scrollHeight,
    );
  }, [navigationItems, viewportMetrics, virtualizer]);

  const scrollToNavigationItem = useCallback(
    (item: MessageNavigationItem) => {
      stickyRef.current = false;
      virtualizer.scrollToIndex(item.turnIndex, {
        align: "start",
        behavior: "auto",
      });
      requestAnimationFrame(updateViewportMetrics);
    },
    [updateViewportMetrics, virtualizer],
  );
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0),
  );

  return (
    <ThreadPrimitive.Root
      onWheel={isEmpty ? (e) => e.preventDefault() : undefined}
      className={cn(
        "aui-root aui-thread-root @container relative flex h-full flex-col",
      )}
      style={{
        ["--thread-max-width" as string]: "50rem",
        ["--composer-radius" as string]: "var(--radius-xl)",
        ["--composer-padding" as string]: "12px",
        ["--assistant-footer-offset" as string]: "30px",
        ["--history-to-composer-gap" as string]: "16px",
      }}
    >
      <ThreadMessageNavigator
        items={navigationItems}
        activeIndex={activeNavigationIndex}
        onSelect={scrollToNavigationItem}
      />
      <div
        ref={scrollerRef}
        data-slot="aui_thread-viewport"
        // 不能用 scroll-smooth：贴底维持是通过直接写 scrollTop 高频做的，
        // CSS smooth 会让每次写入都变成几百毫秒的动画，越写越追不上内容增长，
        // 体感就是"跳到顶部/底部很慢"。需要的话应在具体一次性操作里单独传
        // behavior: "smooth"，而不是整个容器全局开启。
        className={cn(
          "overflow-x-hidden overscroll-contain [overflow-anchor:none]",
          isEmpty ? "min-h-0 flex-1 overflow-y-hidden" : "min-h-0 flex-1 overflow-y-auto",
        )}
      >
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-col px-4",
            !isEmpty && "min-h-full pt-4 pb-[calc(var(--assistant-footer-offset)+var(--history-to-composer-gap))]",
          )}
        >
          <div
            data-slot="aui_message-group"
            className="flex flex-col gap-y-8 empty:hidden"
            style={{ paddingTop, paddingBottom }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="flex flex-col gap-y-8"
              >
                {turns[item.index]!.indices.map((index) => (
                  <ThreadPrimitive.MessageByIndex
                    key={index}
                    index={index}
                    components={MESSAGE_COMPONENTS}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={cn(
        "aui-thread-viewport-footer flex w-full max-w-(--thread-max-width) flex-col px-4",
        isEmpty
          ? "absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
          : "relative mx-auto shrink-0 gap-4 pb-4 md:pb-6",
      )}>
        <div
          ref={composerLayoutRef}
          className={cn(
            "w-full will-change-transform",
            !isEmpty && "flex flex-col gap-4",
          )}
        >
          <TooltipIconButton
            tooltip="滚动到底部"
            variant="outline"
            disabled={isAtBottom}
            onClick={scrollToBottomSmooth}
            className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
          >
            <ArrowDownIcon />
          </TooltipIconButton>
          <PendingQuestionPanel />
          {isEmpty ? (
            <div className="relative flex w-full flex-col items-center">
              <div className="absolute bottom-full mb-6 w-full">
                <ThreadWelcome />
              </div>
              <Composer onTextareaResize={jumpToBottom} />
            </div>
          ) : (
            <Composer onTextareaResize={jumpToBottom} />
          )}
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
