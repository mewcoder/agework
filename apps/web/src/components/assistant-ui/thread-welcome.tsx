
import { useEffect, useId, useState } from "react";
import { motion, AnimatePresence, LayoutGroup } from "motion/react";
import { Button } from "@/components/ui/button";
import { SuggestionPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { useSelectionStore } from "@/stores/selection-store";

// ── Letter animation ─────────────────────────────────────────────────────

type WordmarkPhase = "brand" | "welcome";

const WORDMARK_TOKENS = {
  brand: [
    { text: "Age", id: "age" },
    { text: "Work", id: "work" },
  ],
  welcome: [
    { text: "Work", id: "work" },
    { text: "with", id: "with" },
    { text: "Age", id: "age" },
    { text: "nt", id: "agent-tail" },
  ],
} satisfies Record<WordmarkPhase, Array<{ text: string; id: string }>>;

const PHASE_CHANGE_DELAY_MS = 500;
const WORDMARK_MOVE_TRANSITION = {
  type: "spring",
  stiffness: 360,
  damping: 30,
  mass: 0.9,
} as const;

function tokenInitial(id: string) {
  if (id === "with") return { opacity: 0, x: 16, filter: "blur(4px)" };
  if (id === "agent-tail") return { opacity: 0, x: -8, filter: "blur(4px)" };
  return false;
}

function phaseLabel(phase: WordmarkPhase) {
  return phase === "brand" ? "AgeWork" : "Work with Agent";
}

function WordmarkToken({
  text,
  id,
  "data-gap": dataGap,
}: {
  text: string;
  id: string;
  "data-gap"?: "word";
}) {
  return (
    <motion.span
      layout
      layoutId={`wordmark-${id}`}
      initial={tokenInitial(id)}
      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
      exit={{ opacity: 0, x: -10, filter: "blur(4px)" }}
      transition={{
        opacity: { duration: 0.22 },
        x: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
        filter: { duration: 0.22 },
        layout: WORDMARK_MOVE_TRANSITION,
      }}
      aria-hidden="true"
      data-gap={dataGap}
      className="inline-flex whitespace-pre data-[tone=muted]:text-muted-foreground/70 data-[tone=strong]:text-foreground"
      data-tone={id === "work" || id === "age" ? "strong" : "muted"}
    >
      {text}
    </motion.span>
  );
}

// ── Suggestions ──────────────────────────────────────────────────────────

function ThreadSuggestionItem() {
  return (
    <div className="aui-thread-welcome-suggestion-display animate-in duration-200 fill-mode-both fade-in slide-in-from-bottom-2 nth-[n+3]:hidden @md:nth-[n+3]:block">
      <SuggestionPrimitive.Trigger send asChild>
        <Button
          variant="ghost"
          className="aui-thread-welcome-suggestion h-auto w-full flex-wrap items-start justify-start gap-1 rounded-3xl border bg-background px-4 py-3 text-start text-sm transition-colors hover:bg-muted @md:flex-col"
        >
          <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 font-medium" />
          <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
        </Button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
}

function ThreadSuggestions() {
  return (
    <div className="aui-thread-welcome-suggestions grid w-full gap-2 pb-4 @md:grid-cols-2">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
}

// ── Welcome ──────────────────────────────────────────────────────────────

function ThreadWelcomeWordmark({ animationId }: { animationId: number }) {
  const instanceId = useId();
  const [phase, setPhase] = useState<WordmarkPhase>("brand");
  const tokens = WORDMARK_TOKENS[phase];

  useEffect(() => {
    const id = window.setTimeout(() => setPhase("welcome"), PHASE_CHANGE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <>
      <span className="sr-only">{phaseLabel(phase)}</span>
      <LayoutGroup id={`thread-welcome-${instanceId}-${animationId}`}>
        <motion.div
          layout
          transition={{ layout: WORDMARK_MOVE_TRANSITION }}
          aria-hidden="true"
          className={
            phase === "welcome"
              ? "agework-wordmark flex min-h-11 min-w-[min(20rem,calc(100vw-2rem))] items-center justify-center text-center text-3xl whitespace-nowrap text-muted-foreground @md:text-4xl [&>[data-gap=word]]:ml-[0.28em]"
              : "agework-wordmark flex min-h-11 min-w-[min(20rem,calc(100vw-2rem))] items-center justify-center text-center text-3xl whitespace-nowrap text-muted-foreground @md:text-4xl"
          }
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {tokens.map((token, index) => (
              <WordmarkToken
                key={token.id}
                id={token.id}
                text={token.text}
                data-gap={
                  phase === "welcome" && (index === 1 || index === 2)
                    ? "word"
                    : undefined
                }
              />
            ))}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>
    </>
  );
}

export function ThreadWelcome() {
  const newConversationToken = useSelectionStore((s) => s.newConversationFocusToken);

  return (
    <div className="aui-thread-welcome-root flex flex-col items-center select-none">
      <ThreadWelcomeWordmark
        key={newConversationToken}
        animationId={newConversationToken}
      />
      <ThreadSuggestions />
    </div>
  );
}
