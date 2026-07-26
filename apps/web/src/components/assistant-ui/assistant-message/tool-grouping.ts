import type { ReactNode } from "react";

export type ToolGroupItem = {
  key: string | number;
  status?: { type?: string };
  children: ReactNode;
};

export type ToolGroupCluster = {
  kind: "completed" | "single";
  items: ToolGroupItem[];
};

/** Keep only adjacent completed calls in the same collapsed cluster. */
export function groupToolItems(items: ToolGroupItem[]): ToolGroupCluster[] {
  const groups: ToolGroupCluster[] = [];

  for (const item of items) {
    if (
      item.status?.type === "complete" &&
      groups.at(-1)?.kind === "completed"
    ) {
      groups.at(-1)!.items.push(item);
    } else {
      groups.push({
        kind: item.status?.type === "complete" ? "completed" : "single",
        items: [item],
      });
    }
  }

  return groups;
}

export function visibleToolItems(items: ToolGroupItem[]): ToolGroupItem[] {
  return items;
}
