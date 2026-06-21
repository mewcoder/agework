// 从 assistant-ui 消息 content（string / part 数组 / { role, content } 对象）提取纯文本
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string"
      )
      .map((p) => p.text)
      .join(" ");
  }
  // assistant-ui 消息：{ id, role, content: [...] }，递归提取其 content 字段
  if (
    content !== null &&
    typeof content === "object" &&
    "content" in content
  ) {
    return extractText((content as { content: unknown }).content);
  }
  return "";
}
