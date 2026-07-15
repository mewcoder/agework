import { describe, expect, it } from "vitest";
import {
  isHostTunnelClientMessage,
  isHostTunnelClientNotification,
  isHostTunnelHostRpcRequest,
  isHostTunnelRegisteredMessage,
  isWorkerCommandPollResponse,
  isWorkerRegisterRequest,
  isWorkerRegisterResponse,
  isWorkerRunConfigResponse,
} from "./wire";

describe("runtime wire decoders", () => {
  it("accepts both sides of the Host tunnel handshake", () => {
    expect(
      isHostTunnelClientMessage({
        type: "register",
        protocolVersion: 1,
        capabilities: {
          docker: { available: true, scopes: ["user", "workspace"] },
        },
      })
    ).toBe(true);
    expect(
      isHostTunnelRegisteredMessage({
        type: "registered",
        runtimeHostId: "host-1",
        heartbeatIntervalSeconds: 10,
        protocolVersion: 1,
        epoch: 1,
      })
    ).toBe(true);
  });

  it("rejects malformed or legacy Host tunnel handshakes", () => {
    expect(
      isHostTunnelClientMessage({
        type: "register",
        protocolVersion: 1,
        capabilities: { scopes: ["workspace"] },
      })
    ).toBe(false);
    expect(
      isHostTunnelRegisteredMessage({
        type: "registered",
        runtimeHostId: "host-1",
        heartbeatIntervalSeconds: "10",
        protocolVersion: 1,
      })
    ).toBe(false);
  });

  it("accepts known Host RPC methods and rejects unknown or invalid params", () => {
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "req-1",
        method: "host.listFiles",
        params: {
          runtimeHostId: "host-1",
          rootPath: "/workspace",
          path: "src",
        },
      })
    ).toBe(true);
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "req-2",
        method: "host.listFiles",
        params: { runtimeHostId: "host-1", path: "src" },
      })
    ).toBe(false);
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "req-3",
        method: "host.legacyMethod",
        params: {},
      })
    ).toBe(false);
  });

  it("validates Host upstream envelopes before dispatch", () => {
    expect(
      isHostTunnelClientNotification({
        jsonrpc: "2.0",
        method: "host.upstream",
        params: {
          seq: 1,
          epoch: 2,
          notification: { kind: "runCancelled", runId: "run-1" },
        },
      })
    ).toBe(true);
    expect(
      isHostTunnelClientNotification({
        jsonrpc: "2.0",
        method: "host.upstream",
        params: { kind: "runCancelled", runId: "legacy-run" },
      })
    ).toBe(false);
  });

  it("validates the Worker registration request and response together", () => {
    expect(
      isWorkerRegisterRequest({
        startToken: "token-1",
        pid: 42,
        protocolVersion: 1,
      })
    ).toBe(true);
    expect(isWorkerRegisterResponse({ ok: true, protocolVersion: 1 })).toBe(
      true
    );
    expect(isWorkerRegisterResponse({ ok: true })).toBe(false);
  });

  it("validates Worker command and run-config HTTP responses", () => {
    expect(
      isWorkerCommandPollResponse({
        messages: [
          {
            jsonrpc: "2.0",
            id: "cmd-1",
            method: "run.interrupt",
            params: { runId: "run-1" },
          },
        ],
        queueEpoch: 1,
      })
    ).toBe(true);
    expect(
      isWorkerCommandPollResponse({ messages: [{ method: "run.interrupt" }] })
    ).toBe(false);

    expect(
      isWorkerRunConfigResponse({
        config: {
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          runtimePath: "/workspace",
          env: {},
          input: {},
          agentProviderConfig: { agentType: "claude", source: "system" },
        },
      })
    ).toBe(true);
    expect(isWorkerRunConfigResponse({ config: { runId: "run-1" } })).toBe(
      false
    );
  });
});
