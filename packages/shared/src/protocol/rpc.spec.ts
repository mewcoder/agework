import { describe, expect, it } from "vitest";
import type { RunChannelMessage } from "./run-channel-message";
import type { CommandPayload, UpstreamMessage } from "./channel";
import {
  commandMessageToRpcRequest,
  commandResultMessageToRpcResponse,
  commandResultToRpcResponse,
  isRunConfigRpcNotification,
  isWorkerCommandResultRpcResponse,
  isWorkerCommandRpcRequest,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcNotificationToRunConfigMessage,
  rpcResponseToCommandResultMessage,
  rpcRequestToCommandMessage,
  runConfigMessageToRpcNotification,
  upstreamMessageToRpcNotification,
} from "./rpc";

describe("worker JSON-RPC protocol helpers", () => {
  it("maps command messages to RPC requests", () => {
    const message: RunChannelMessage<CommandPayload> = {
      runId: "run-1",
      seq: 7,
      type: "command",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conv-1",
      },
      ts: "2026-06-27T00:00:00.000Z",
    };

    const request = commandMessageToRpcRequest(message);

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: "cmd-1",
      method: "run.cancel",
      params: {
        runId: "run-1",
        conversationId: "conv-1",
      },
      meta: {
        runId: "run-1",
        seq: 7,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
  });

  it("maps RPC requests back to command messages", () => {
    const message = rpcRequestToCommandMessage({
      jsonrpc: "2.0",
      id: "cmd-1",
      method: "control.resolve",
      params: {
        runId: "run-1",
        conversationId: "conv-1",
        answers: { allowed: "yes" },
      },
      meta: {
        runId: "run-1",
        seq: 3,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });

    expect(message).toEqual({
      runId: "run-1",
      seq: 3,
      type: "command",
      payload: {
        type: "approval_resolved",
        commandId: "cmd-1",
        conversationId: "conv-1",
        answers: { allowed: "yes" },
      },
      ts: "2026-06-27T00:00:00.000Z",
    });
  });

  it("keeps runId on interrupt command round trips", () => {
    const request = commandMessageToRpcRequest({
      runId: "run-1",
      seq: 4,
      type: "command",
      payload: {
        type: "interrupt",
        commandId: "cmd-2",
        runId: "run-1",
      },
      ts: "2026-06-27T00:00:00.000Z",
    });

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: "cmd-2",
      method: "run.interrupt",
      params: { runId: "run-1" },
      meta: {
        runId: "run-1",
        seq: 4,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    expect(rpcRequestToCommandMessage(request).payload).toEqual({
      type: "interrupt",
      commandId: "cmd-2",
      runId: "run-1",
    });
  });

  it("maps run config messages to RPC notifications and back", () => {
    const config = {
      runId: "run-1",
      conversationId: "conv-1",
      workspaceId: "ws-1",
      runtimePath: "/workspace",
      env: {},
      input: {},
      agentProviderConfig: { agentType: "claude", source: "system" },
    } as const;
    const notification = runConfigMessageToRpcNotification({
      runId: "run-1",
      seq: 0,
      type: "run.config",
      payload: config,
      ts: "2026-06-27T00:00:00.000Z",
    });

    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "run.config",
      params: {
        runId: "run-1",
        config,
      },
      meta: {
        runId: "run-1",
        seq: 0,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    expect(rpcNotificationToRunConfigMessage(notification)).toEqual({
      runId: "run-1",
      seq: 0,
      type: "run.config",
      payload: config,
      ts: "2026-06-27T00:00:00.000Z",
    });
  });

  it("maps upstream messages to RPC notifications and back", () => {
    const message: UpstreamMessage = {
      runId: "run-1",
      seq: 2,
      type: "run.status",
      payload: { status: "running" },
      ts: "2026-06-27T00:00:00.000Z",
    };

    const notification = upstreamMessageToRpcNotification(message);

    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "run.status",
      params: {
        runId: "run-1",
        status: { status: "running" },
      },
      meta: {
        runId: "run-1",
        seq: 2,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    expect(rpcNotificationToUpstreamMessage(notification)).toEqual(message);
    expect(isWorkerEventRpcNotification(notification)).toBe(true);
  });

  it("rejects command requests with invalid params", () => {
    expect(
      isWorkerCommandRpcRequest({
        jsonrpc: "2.0",
        id: "cmd-1",
        method: "run.cancel",
        params: {
          runId: "run-1",
        },
        meta: {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-27T00:00:00.000Z",
        },
      })
    ).toBe(false);

    expect(
      isWorkerCommandRpcRequest({
        jsonrpc: "2.0",
        id: "cmd-2",
        method: "control.resolve",
        params: {
          runId: "run-1",
          conversationId: "conv-1",
          answers: { approved: [true] },
        },
      })
    ).toBe(false);

    expect(
      isWorkerCommandRpcRequest({
        jsonrpc: "2.0",
        id: "cmd-3",
        method: "run.interrupt",
        params: {},
      })
    ).toBe(false);
  });

  it("rejects worker event notifications with invalid params", () => {
    expect(
      isWorkerEventRpcNotification({
        jsonrpc: "2.0",
        method: "run.aguiEvent",
        params: {
          runId: "run-1",
          event: { payload: {} },
        },
      })
    ).toBe(false);

    expect(
      isWorkerEventRpcNotification({
        jsonrpc: "2.0",
        method: "run.status",
        params: {
          runId: "run-1",
          status: { status: "almost-running" },
        },
      })
    ).toBe(false);
  });

  it("validates run.config notification params", () => {
    expect(
      isRunConfigRpcNotification({
        jsonrpc: "2.0",
        method: "run.config",
        params: {
          runId: "run-1",
          config: {
            runId: "run-1",
            conversationId: "conv-1",
            workspaceId: "ws-1",
            runtimePath: "/workspace",
            env: {},
            input: {},
            agentProviderConfig: { agentType: "claude", source: "system" },
          },
        },
      })
    ).toBe(true);

    expect(
      isRunConfigRpcNotification({
        jsonrpc: "2.0",
        method: "run.config",
        params: {
          runId: "run-1",
          config: {
            runId: "run-1",
            conversationId: "conv-1",
            workspaceId: "ws-1",
          },
        },
      })
    ).toBe(false);
  });

  it("creates command result RPC responses", () => {
    expect(
      commandResultToRpcResponse({
        commandId: "cmd-1",
        ok: true,
        runId: "run-1",
        commandType: "cancel",
      })
    ).toEqual({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: {
        ok: true,
        runId: "run-1",
        commandType: "cancel",
      },
    });

    expect(
      commandResultToRpcResponse({
        commandId: "cmd-2",
        ok: false,
        error: "no active run matched",
      })
    ).toMatchObject({
      jsonrpc: "2.0",
      id: "cmd-2",
      error: {
        code: -32000,
        message: "no active run matched",
      },
    });
  });

  it("maps command result messages to RPC responses and back", () => {
    const response = commandResultMessageToRpcResponse({
      runId: "run-1",
      seq: 5,
      type: "command.result",
      payload: {
        commandId: "cmd-1",
        commandType: "cancel",
        status: "ok",
      },
      ts: "2026-06-27T00:00:00.000Z",
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: {
        ok: true,
        runId: "run-1",
        commandType: "cancel",
      },
      meta: {
        runId: "run-1",
        seq: 5,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    expect(rpcResponseToCommandResultMessage(response)).toEqual({
      runId: "run-1",
      seq: 5,
      type: "command.result",
      payload: {
        commandId: "cmd-1",
        commandType: "cancel",
        status: "ok",
      },
      ts: "2026-06-27T00:00:00.000Z",
    });
    expect(isWorkerCommandResultRpcResponse(response)).toBe(true);
    expect(
      isWorkerCommandResultRpcResponse({
        jsonrpc: "2.0",
        id: "cmd-1",
        result: { ok: true },
      })
    ).toBe(false);
  });
});
