import { useCallback, useState } from "react";
import { copyToClipboard } from "@/utils/clipboard";
import type { GroupableMessagePart } from "@/components/assistant-ui/thread-utils";

/**
 * 复制消息文本：拼接所有 text part（可选排除处理过程标题文本），2s 后重置 copied 状态
 */
export function useCopyMessageText(
  parts: readonly GroupableMessagePart[],
  excluded?: WeakSet<GroupableMessagePart> | null,
) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = parts
      .filter(
        (p): p is GroupableMessagePart & { text: string } =>
          p.type === "text" && typeof p.text === "string" && !excluded?.has(p),
      )
      .map((p) => p.text)
      .join("\n\n")
      .trim();

    if (!text) return;
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("[useCopyMessageText] clipboard copy failed:", e);
    }
  }, [parts, excluded]);

  return { copied, handleCopy };
}
