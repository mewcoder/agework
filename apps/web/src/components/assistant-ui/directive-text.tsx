"use client";

import { memo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";

const DirectiveTextImpl: TextMessagePartComponent = ({ text }) => {
  const segments = slashCommandFormatter.parse(text);

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
            {`/${seg.label}`}
          </span>
        ),
      )}
    </>
  );
};

DirectiveTextImpl.displayName = "DirectiveText";

/** 自定义 formatter：序列化为 `/skill-name` 纯文本。消息侧与 composer 叠加层共用，保证高亮一致。 */
export const slashCommandFormatter = {
  serialize: (item: { id: string; label: string; type: string }) => `/${item.label}`,
  parse: (text: string) => {
    const segments: Array<
      | { kind: "text"; text: string }
      | { kind: "mention"; type: string; label: string; id: string }
    > = [];

    const slashRe = /\/([\w-]+)/g;
    let lastIndex = 0;

    for (const match of text.matchAll(slashRe)) {
      if (match.index > lastIndex) {
        segments.push({
          kind: "text",
          text: text.slice(lastIndex, match.index),
        });
      }
      segments.push({
        kind: "mention",
        type: "command",
        label: match[1]!,
        id: match[1]!,
      });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      segments.push({ kind: "text", text: text.slice(lastIndex) });
    }

    return segments;
  },
};

export const DirectiveText: TextMessagePartComponent = memo(DirectiveTextImpl);
