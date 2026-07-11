"use client";

import { memo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";

// ── Types ──────────────────────────────────────────────────────────────────

export type DirectiveSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; type: "command" | "file"; label: string; id: string };

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Combined regex: matches either `/command` or `@file-path` tokens.
 *
 * - `/([\w-]+)` — slash commands (no boundary rule, matches anywhere)
 * - `(?:^|\s)@([^\s@]+)` — file mentions: `@` must be at line start or after
 *   whitespace (kills `foo@bar.com`), followed by non-space non-@ chars.
 *
 * Group 1 = slash command label, Group 2 = file path.
 */
const directiveRe = /(?:^|\s)@([^\s@]+)|\/([\w-]+)/g;

/**
 * Parse text into segments: plain text, `/command` mentions, and `@file` mentions.
 *
 * @param knownFiles — if provided, `@path` is only treated as a file mention when
 *   the path exists in this set (existence check per SPEC §4). If omitted, all
 *   boundary-matched `@path` tokens are treated as mentions (used in message
 *   rendering where paths were already validated at compose time).
 */
export function parseDirectives(
  text: string,
  knownFiles?: Set<string>,
): DirectiveSegment[] {
  const segments: DirectiveSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(directiveRe)) {
    const isFile = match[1] !== undefined;
    const isCommand = match[2] !== undefined;

    if (isFile) {
      const path = match[1]!;
      // Existence check: if knownFiles is provided, only highlight real paths
      if (knownFiles && !knownFiles.has(path)) continue;

      // The match includes leading whitespace (e.g. " @src/foo.ts").
      // Calculate the position of `@` so the whitespace goes into the preceding text.
      const atPos = match.index! + match[0].length - path.length - 1;
      if (atPos > lastIndex) {
        segments.push({ kind: "text", text: text.slice(lastIndex, atPos) });
      }
      segments.push({ kind: "mention", type: "file", label: path, id: path });
      lastIndex = atPos + 1 + path.length;
    } else if (isCommand) {
      const label = match[2]!;
      if (match.index! > lastIndex) {
        segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
      }
      segments.push({ kind: "mention", type: "command", label, id: label });
      lastIndex = match.index! + match[0].length;
    }
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }

  return segments;
}

// ── Formatter (for trigger popover directive behavior) ─────────────────────

/**
 * Slash command formatter: serializes items as `/skill-name` plain text.
 * The `parse` here is a pass-through — actual parsing for highlighting
 * is done by `parseDirectives` above.
 */
export const slashCommandFormatter = {
  serialize: (item: { id: string; label: string; type: string }) =>
    `/${item.label}`,
  parse: (text: string): DirectiveSegment[] => [{ kind: "text", text }],
};

/**
 * File mention formatter: serializes items as `@path` plain text.
 * Same pass-through parse pattern as slashCommandFormatter.
 */
export const fileMentionFormatter = {
  serialize: (item: { id: string; label: string; type: string }) =>
    `@${item.label}`,
  parse: (text: string): DirectiveSegment[] => [{ kind: "text", text }],
};

// ── Component ───────────────────────────────────────────────────────────────

const DirectiveTextImpl: TextMessagePartComponent = ({ text }) => {
  const segments = parseDirectives(text);

  if (segments.length === 1 && segments[0]!.kind === "text") {
    return <>{text}</>;
  }

  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i} className="whitespace-pre-wrap">
            {seg.text}
          </span>
        ) : (
          <span
            key={i}
            data-slot="directive-text-chip"
            data-directive-type={seg.type}
            data-directive-id={seg.id}
            aria-label={`${seg.type}: ${seg.label}`}
            className="aui-directive-chip text-blue-700 dark:text-blue-300"
          >
            {seg.type === "file" ? `@${seg.label}` : `/${seg.label}`}
          </span>
        ),
      )}
    </>
  );
};

DirectiveTextImpl.displayName = "DirectiveText";

export const DirectiveText: TextMessagePartComponent = memo(DirectiveTextImpl);
