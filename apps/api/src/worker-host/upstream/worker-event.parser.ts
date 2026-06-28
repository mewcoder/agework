import type { RunChannelMessage } from "@agework/shared/protocol";
import {
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
} from "@agework/shared/protocol/rpc";

export function parseWorkerEventPostBody(
  body: unknown,
  routeRunId?: string
): RunChannelMessage[] | undefined {
  if (Array.isArray(body)) {
    if (body.length === 0) return undefined;
    const events: RunChannelMessage[] = [];
    for (const message of body) {
      const normalized = parseWorkerEventPostItem(message, routeRunId);
      if (!normalized) return undefined;
      events.push(normalized);
    }
    return events;
  }

  const event = parseWorkerEventPostItem(body, routeRunId);
  return event ? [event] : undefined;
}

function parseWorkerEventPostItem(
  body: unknown,
  routeRunId?: string
): RunChannelMessage | undefined {
  if (isWorkerEventRpcNotification(body)) {
    return rpcNotificationToUpstreamMessage(body);
  }
  if (isWorkerCommandResultRpcResponse(body)) {
    return rpcResponseToCommandResultMessage(body, { runId: routeRunId });
  }
  return undefined;
}
