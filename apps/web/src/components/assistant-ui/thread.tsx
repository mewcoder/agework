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
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";

// 滚动容器用 shadcn message-scroller(@shadcn/react/message-scroller)接管贴底/
// 自动跟随/autoScroll 状态机/ResizeObserver 维持,替代原先手写的 stickyRef + onScroll/
// onWheel/ResizeObserver 那一套。消息列表仍用 @tanstack/react-virtual 虚拟化(长对话
// 性能),虚拟化 item 的绝对定位 + getTotalSize 撑高和 message-scroller 的 spacer 机制
// 共存:spacer 隐藏,高度完全由中间 relative 容器的 height 撑起。
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
                  "min-h-8 w-full rounded-lg px-3 py-1.5 text-left text-sm leading-6 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none",
                  index === activeIndex && "bg-accent text-foreground",
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

type ThreadScrollerProps = {
  turns: readonly Turn[];
  navigationItems: readonly MessageNavigationItem[];
  isEmpty: boolean;
  isRunning: boolean;
  mainThreadId: string | null;
  composerLayoutRef: React.Ref<HTMLDivElement>;
};

// 必须作为 MessageScrollerProvider 的子组件渲染——useMessageScroller /
// useMessageScrollerScrollable 内部用 useContext 拿 Provider 的 scroll 上下文,
// 在 Provider 外调用会抛 "useMessageScroller must be used within a MessageScroller"。
// 这里持有虚拟化器、贴底跳转 effect、导航高亮和消息列表渲染。
function ThreadScroller({
  turns,
  navigationItems,
  isEmpty,
  isRunning,
  mainThreadId,
  composerLayoutRef,
}: ThreadScrollerProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 导航高亮(resolveActiveNavigationIndex)需要当前 scrollTop/clientHeight/
  // scrollHeight。message-scroller 没暴露这些,这里通过 Viewport 的 onScroll
  // 透传读取。贴底/自动跟随本身不依赖它——那部分交给 message-scroller 的 autoScroll。
  const [viewportMetrics, setViewportMetrics] = useState({
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
  });
  const { scrollToEnd } = useMessageScroller();
  // useMessageScrollerScrollable().end 语义是"能否往 end 方向滚"(true=没到底),
  // "已到底"是它的否定 !end。
  const { end } = useMessageScrollerScrollable();
  const isAtBottom = !end;

  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => ESTIMATED_TURN_HEIGHT,
    getItemKey: (index) => turns[index]!.id,
    getScrollElement: () => scrollerRef.current,
    initialRect: { height: 800, width: 800 },
    overscan: 4,
  });

  // 后台会话在 / ↔ /c/$conversationId 间常驻挂载（见 workbench.tsx），同一个
  // Thread 实例会被多个会话复用，所以"是否已经跳过底部"要按 mainThreadId 记录，
  // 而不能用一次性的 ref——否则切换会话后不会重新跳到新会话的底部。
  // message-scroller 的 defaultScrollPosition="end" 只在 Provider 首次挂载时应用
  // 一次，切会话不会重跑，所以仍需这里按 mainThreadId 主动 scrollToEnd。
  const lastJumpedThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (turns.length === 0 || lastJumpedThreadIdRef.current === mainThreadId) return;
    lastJumpedThreadIdRef.current = mainThreadId;
    scrollToEnd({ behavior: "auto" });
  }, [mainThreadId, turns.length, scrollToEnd]);

  // 同理，"运行开始时跳到底部"的上一次状态也要按 mainThreadId 记录，否则从一个
  // 运行中的会话切到另一个运行中的会话时，isRunning 始终是 true，检测不到"开始"。
  const runningThreadIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (isRunning) {
      if (runningThreadIdRef.current !== mainThreadId) scrollToEnd({ behavior: "auto" });
      runningThreadIdRef.current = mainThreadId;
    } else {
      runningThreadIdRef.current = null;
    }
  }, [isRunning, mainThreadId, scrollToEnd]);

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
      virtualizer.scrollToIndex(item.turnIndex, {
        align: "start",
        behavior: "auto",
      });
    },
    [virtualizer],
  );
  const paddingTop = items[0]?.start ?? 0;
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0),
  );

  return (
    <>
      {/* 导航面板放在 MessageScroller 外:MessageScroller 薄壳自带 overflow-hidden,
          会裁掉 hover 面板的 shadow-lg 和溢出部分。导航是绝对定位,定位上下文是
          ThreadPrimitive.Root(relative),不需要在滚动容器内。 */}
      <ThreadMessageNavigator
        items={navigationItems}
        activeIndex={activeNavigationIndex}
        onSelect={scrollToNavigationItem}
      />
      <MessageScroller className="aui-thread-root relative flex h-full flex-col">
      <MessageScrollerViewport
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
        onScroll={() => {
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
        }}
      >
        <MessageScrollerContent
          spacerClassName="hidden"
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-col px-4",
            !isEmpty && "min-h-full pt-4 pb-[calc(var(--assistant-footer-offset)+var(--history-to-composer-gap))]",
          )}
        >
          <div
            data-slot="aui_message-group"
            className="relative w-full flex flex-col gap-y-8 empty:hidden"
            style={{ height: virtualizer.getTotalSize(), paddingTop, paddingBottom }}
          >
            {items.map((item) => (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute start-0 top-0 w-full flex flex-col gap-y-8"
                style={{ transform: `translateY(${item.start}px)` }}
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
        </MessageScrollerContent>
      </MessageScrollerViewport>

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
            onClick={() => scrollToEnd({ behavior: "smooth" })}
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
              <Composer onTextareaResize={() => scrollToEnd({ behavior: "auto" })} />
            </div>
          ) : (
            <Composer onTextareaResize={() => scrollToEnd({ behavior: "auto" })} />
          )}
        </div>
      </div>
    </MessageScroller>
    </>
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
  const composerLayoutRef = useLayoutShiftAnimation<HTMLDivElement>([
    isEmpty,
    mainThreadId,
  ]);

  const navigationItems = useMemo(
    () => buildNavigationItems(aui.thread().getState().messages, turns),
    [messagesFingerprint, turns, aui], // eslint-disable-line react-hooks/exhaustive-deps
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
      {/* scrollEdgeThreshold 放宽到 64px:流式回复时最后一条消息不停增高/reflow,
          默认 8px 太小,两次自动贴底之间的瞬时小缝隙容易被 message-scroller 误判成
          "用户手动上滚"从而退出 following-bottom,回复中途就不再自动贴底。 */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={64}>
        <ThreadScroller
          turns={turns}
          navigationItems={navigationItems}
          isEmpty={isEmpty}
          isRunning={isRunning}
          mainThreadId={mainThreadId}
          composerLayoutRef={composerLayoutRef}
        />
      </MessageScrollerProvider>
    </ThreadPrimitive.Root>
  );
}
