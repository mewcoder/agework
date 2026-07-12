import type { ContentBlock } from "@agentclientprotocol/sdk";

/**
 * Render an ACP {@link ContentBlock} as text for AG-UI text streaming. Non-text
 * blocks become a compact descriptor rather than being dropped or stringified
 * whole (doc §12.2).
 */
export function contentBlockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.mimeType}]`;
    case "audio":
      return `[audio ${block.mimeType}]`;
    case "resource_link":
      return `[resource ${block.name || block.uri}]`;
    case "resource":
      return "[embedded resource]";
    default:
      return "";
  }
}
