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
        protocolVersion: 3,
        processInstanceId: "proc-1",
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
        protocolVersion: 3,
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

  it("v3 submitRun: accepts placement with scope + userLifecycleVersion, rejects legacy owner field", () => {
    const validPlacement = {
      scope: "workspace",
      runtimeType: "docker",
      runtimeHostId: "host-1",
      workspaceId: "ws-1",
      userId: "u1",
      userLifecycleVersion: 1,
      username: "alice",
      workspacePath: "/data/ws-1",
    };
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "submit-1",
        method: "host.submitRun",
        params: {
          runId: "run-1",
          conversationId: "conv-1",
          placement: validPlacement,
          agentProviderConfig: { agentType: "claude", source: "system" },
          input: {},
        },
      })
    ).toBe(true);

    // legacy owner field instead of scope → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "submit-2",
        method: "host.submitRun",
        params: {
          runId: "run-1",
          conversationId: "conv-1",
          placement: {
            owner: "workspace:ws-1",
            runtimeType: "docker",
            runtimeHostId: "host-1",
            workspaceId: "ws-1",
            userId: "u1",
            username: "alice",
            workspacePath: "/data/ws-1",
          },
          agentProviderConfig: { agentType: "claude", source: "system" },
          input: {},
        },
      })
    ).toBe(false);

    // missing userLifecycleVersion → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "submit-3",
        method: "host.submitRun",
        params: {
          runId: "run-1",
          conversationId: "conv-1",
          placement: {
            scope: "workspace",
            runtimeType: "docker",
            runtimeHostId: "host-1",
            workspaceId: "ws-1",
            userId: "u1",
            username: "alice",
            workspacePath: "/data/ws-1",
          },
          agentProviderConfig: { agentType: "claude", source: "system" },
          input: {},
        },
      })
    ).toBe(false);

    // invalid scope → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "submit-4",
        method: "host.submitRun",
        params: {
          runId: "run-1",
          conversationId: "conv-1",
          placement: {
            ...validPlacement,
            scope: "tenant",
          },
          agentProviderConfig: { agentType: "claude", source: "system" },
          input: {},
        },
      })
    ).toBe(false);
  });

  it("v3 releaseResources: accepts workspace/user targets, rejects legacy host.releaseOwner", () => {
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "rel-1",
        method: "host.releaseResources",
        params: {
          runtimeHostId: "host-1",
          target: { type: "workspace", workspaceId: "ws-1" },
        },
      })
    ).toBe(true);
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "rel-2",
        method: "host.releaseResources",
        params: {
          runtimeHostId: "host-1",
          target: {
            type: "user",
            userId: "u1",
            userLifecycleVersion: 3,
          },
        },
      })
    ).toBe(true);
    // user target without userLifecycleVersion → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "rel-3",
        method: "host.releaseResources",
        params: {
          runtimeHostId: "host-1",
          target: { type: "user", userId: "u1" },
        },
      })
    ).toBe(false);
    // legacy host.releaseOwner → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "rel-4",
        method: "host.releaseOwner",
        params: { runtimeHostId: "host-1", owner: "workspace:ws-1" },
      })
    ).toBe(false);
  });

  it("v3 stopWorker: uses workerId, rejects legacy key field", () => {
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "stop-1",
        method: "host.stopWorker",
        params: { runtimeHostId: "host-1", workerId: "worker-1" },
      })
    ).toBe(true);
    // legacy key field → reject
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "stop-2",
        method: "host.stopWorker",
        params: { runtimeHostId: "host-1", key: "workspace:ws-1#docker" },
      })
    ).toBe(false);
  });

  it("v3 listLifecycleClaims: accepts runtimeHostId param", () => {
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "claims-1",
        method: "host.listLifecycleClaims",
        params: { runtimeHostId: "host-1" },
      })
    ).toBe(true);
    expect(
      isHostTunnelHostRpcRequest({
        jsonrpc: "2.0",
        id: "claims-2",
        method: "host.listLifecycleClaims",
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
