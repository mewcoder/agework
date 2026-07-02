export function safePathPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "unknown").slice(0, 120);
}
