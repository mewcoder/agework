"use client";

import { forwardRef } from "react";
import { useAuiState } from "@assistant-ui/react";
import { parseDirectives } from "@/components/assistant-ui/directive-text";
import { cn } from "@/lib/utils";

/**
 * Read-only backdrop that mirrors the composer textarea and highlights
 * `/slash-command` and `@file-mention` tokens. The textarea rendered above
 * shows transparent text plus a visible caret; this layer shows the colored
 * text underneath. Its typography/padding MUST stay identical to the
 * `<ComposerPrimitive.Input>` className so line wrapping lines up; scroll is
 * synced by the composer.
 *
 * `knownFiles` enables the existence check (SPEC §4): `@path` is only
 * highlighted when the path is in this Set. Omit to highlight all
 * boundary-matched `@path` tokens (used in message rendering).
 */
export const ComposerDirectiveOverlay = forwardRef<
  HTMLDivElement,
  { className?: string; knownFiles?: Set<string> }
>(({ className, knownFiles }, ref) => {
  const text = useAuiState((s) => s.composer.text);
  const segments = parseDirectives(text, knownFiles);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden px-1.5 py-0.5 text-[15px] leading-6 text-foreground whitespace-pre-wrap break-words",
        className,
      )}
    >
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          seg.text
        ) : (
          <span key={i} className="text-blue-700 dark:text-blue-300">
            {seg.type === "file" ? `@${seg.label}` : `/${seg.label}`}
          </span>
        ),
      )}
      {/* Preserve the trailing line box when text ends with a newline. */}
      {text.endsWith("\n") ? "​" : null}
    </div>
  );
});

ComposerDirectiveOverlay.displayName = "ComposerDirectiveOverlay";
