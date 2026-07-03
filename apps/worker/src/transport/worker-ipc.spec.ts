import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RunConfig, UpstreamMessage } from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { WorkerIpcTransport } from "./worker-ipc";

const processMock = vi.hoisted(() => ({
  send: vi.fn((_msg: unknown, cb?: (err: Error | null) => void) => {
    cb?.(null);
    return true;
  }),
  handlers: new Map<string, ((msg: unknown) => void)[]>(),
}));

function emitMessage(msg: unknown): void {
  for (const handler of processMock.handlers.get("message") ?? []) {
    handler(msg);
  }
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    runtimePath: "/tmp/ws",
    env: {},
    input: {},
    agentProviderConfig: { agentType: "claude", source: "system" },
    ...overrides,
  } as RunConfig;
}

describe("WorkerIpcTransport", () => {
  beforeEach(() => {
    processMock.send.mockClear();
    processMock.handlers.clear();
    vi.spyOn(process, "send").mockImplementation(
      processMock.send as unknown as any
    );
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: (msg: unknown) => void
    ) => {
      const list = processMock.handlers.get(event) ?? [];
      list.push(handler);
      processMock.handlers.set(event, list);
      return process;
    }) as typeof process.on);
  });

  describe("pollCommands", () => {
    it("resolves immediately with buffered commands received before polling", async () => {
      const transport = new WorkerIpcTransport();
      const message = commandMessageToRpcRequest({
        runId: "run-1",
        seq: 1,
        type: "user_message",
        payload: { type: "user_message", commandId: "cmd-1", runId: "run-1" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      emitMessage(message);

      const commands = await transport.pollCommands(1000);

      expect(commands).toHaveLength(1);
      expect(commands[0].payload.commandId).toBe("cmd-1");
    });

    it("waits for a command to arrive within waitMs", async () => {
      const transport = new WorkerIpcTransport();
      const pending = transport.pollCommands(5000);

      const message = commandMessageToRpcRequest({
        runId: "run-1",
        seq: 1,
        type: "cancel",
        payload: {
          type: "cancel",
          commandId: "cmd-2",
          runId: "run-1",
          conversationId: "conv-1",
        },
        ts: "2026-01-01T00:00:00.000Z",
      });
      emitMessage(message);

      const commands = await pending;
      expect(commands).toHaveLength(1);
      expect(commands[0].payload.commandId).toBe("cmd-2");
    });

    it("resolves with an empty array when waitMs elapses with nothing received", async () => {
      vi.useFakeTimers();
      const transport = new WorkerIpcTransport();
      const pending = transport.pollCommands(50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual([]);
      vi.useRealTimers();
    });

    it("resolves immediately with an empty array when waitMs is 0 and nothing is buffered", async () => {
      const transport = new WorkerIpcTransport();
      await expect(transport.pollCommands(0)).resolves.toEqual([]);
    });
  });

  describe("fetchRunConfig", () => {
    it("resolves once the matching run.config notification arrives, keyed by runId", async () => {
      const transport = new WorkerIpcTransport();
      const pending = transport.fetchRunConfig("run-7");

      const config = makeRunConfig({ runId: "run-7", conversationId: "c-7" });
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-7",
          seq: 0,
          type: "run.config",
          payload: config,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      await expect(pending).resolves.toEqual(config);
    });

    it("ignores a run.config notification for a different runId", async () => {
      const transport = new WorkerIpcTransport();
      const pending = transport.fetchRunConfig("run-8");

      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-9",
          seq: 0,
          type: "run.config",
          payload: makeRunConfig({ runId: "run-9" }),
          ts: "2026-01-01T00:00:00.000Z",
        })
      );
      const expected = makeRunConfig({ runId: "run-8" });
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-8",
          seq: 0,
          type: "run.config",
          payload: expected,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      await expect(pending).resolves.toEqual(expected);
    });

    it("resolves immediately from the buffer when run.config arrives before fetchRunConfig is called (production push-then-pull ordering)", async () => {
      const transport = new WorkerIpcTransport();
      const config = makeRunConfig({ runId: "run-10" });

      // openSession pushes run.config first, sendCommand's user_message triggers
      // fetchRunConfig later — the parent never waits for fetchRunConfig before
      // sending the config, so the config can genuinely arrive first.
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-10",
          seq: 0,
          type: "run.config",
          payload: config,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      await expect(transport.fetchRunConfig("run-10")).resolves.toEqual(config);
    });

    it("rejects if no run.config arrives within the timeout", async () => {
      vi.useFakeTimers();
      const transport = new WorkerIpcTransport();
      const pending = transport.fetchRunConfig("run-11");
      const assertion = expect(pending).rejects.toThrow(
        "Timed out waiting for run.config for run run-11"
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      vi.useRealTimers();
    });
  });

  describe("emit", () => {
    it("sends command.result payloads through process.send", async () => {
      const transport = new WorkerIpcTransport();
      const msg: UpstreamMessage = {
        runId: "run-1",
        seq: 1,
        type: "command.result",
        payload: { commandId: "cmd-1", commandType: "cancel", status: "ok" },
        ts: "",
      };

      await transport.emit("run-1", msg);

      expect(processMock.send).toHaveBeenCalledTimes(1);
    });

    it("sends other upstream messages as notifications through process.send", async () => {
      const transport = new WorkerIpcTransport();
      const msg: UpstreamMessage = {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "running" },
        ts: "",
      };

      await transport.emit("run-1", msg);

      expect(processMock.send).toHaveBeenCalledTimes(1);
    });

    it("rejects when process.send reports an error", async () => {
      processMock.send.mockImplementationOnce(
        (_msg: unknown, cb?: (err: Error | null) => void) => {
          cb?.(new Error("channel closed"));
          return false;
        }
      );
      const transport = new WorkerIpcTransport();

      await expect(
        transport.emit("run-1", {
          runId: "run-1",
          seq: 1,
          type: "run.status",
          payload: { status: "error" },
          ts: "",
        })
      ).rejects.toThrow("channel closed");
    });
  });

  describe("cleanup", () => {
    it("discards any pending fetchRunConfig wait for that runId without resolving or rejecting other runs", async () => {
      const transport = new WorkerIpcTransport();
      const pendingOther = transport.fetchRunConfig("run-keep");
      void transport.fetchRunConfig("run-drop");

      transport.cleanup("run-drop");

      const expected = makeRunConfig({ runId: "run-keep" });
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-keep",
          seq: 0,
          type: "run.config",
          payload: expected,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );
      await expect(pendingOther).resolves.toEqual(expected);
    });

    it("discards a buffered run.config that arrived before fetchRunConfig was ever called", async () => {
      const transport = new WorkerIpcTransport();
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-drop",
          seq: 0,
          type: "run.config",
          payload: makeRunConfig({ runId: "run-drop" }),
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      transport.cleanup("run-drop");

      vi.useFakeTimers();
      const pending = transport.fetchRunConfig("run-drop");
      const assertion = expect(pending).rejects.toThrow(
        "Timed out waiting for run.config for run run-drop"
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      vi.useRealTimers();
    });
  });
});
