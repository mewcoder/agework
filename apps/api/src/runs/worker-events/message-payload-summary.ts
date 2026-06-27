export function summarizeMessagePayload(
  payload: unknown
): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return { value: String(payload) };
  }
  const record = payload as Record<string, unknown>;
  return {
    type: record.type,
    status: record.status,
    pendingAction: record.pendingAction,
    name: record.name,
  };
}
