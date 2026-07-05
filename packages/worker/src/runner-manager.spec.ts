import { dirname, extname, join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  UpstreamMessage,
} from "@agework/shared/protocol";
import {
  commandResultToRpcResponse,
  upstreamMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { WorkerCommands } from "./commands";
import { RunnerManager } from "./runner-manager";

const forkMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  fork: forkMock,
}));

class MockChildProcess extends EventEmitter {
  pid = 1234;
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send = vi.fn((_message: unknown, callback?: (err: Error | null) => void) => {
    callback?.(null);
    return true;
  });
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function makeClient(config = makeRunConfig()) {
  return {
    fetchRunConfig: vi.fn().mockResolvedValue(config),
    pollCommands: vi.fn().mockResolvedValue([]),
    emit: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  };
}

function makeManager(client: ReturnType<typeof makeClient>): RunnerManager {
  return new RunnerManager(
    client,
    new WorkerCommands(client, {
      waitMs: 0,
      emptyRetryDelayMs: 0,
    })
  );
}

function makeRunConfig(): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    runtimePath: "/workspace",
    env: {},
    input: { message: "hello" },
    agentProviderConfig: { agentType: "codex", source: "system" },
    workerLogFilePath: "/tmp/agework-run-1.log",
  };
}

const userMessage: CommandPayload = {
  type: "user_message",
  commandId: "cmd-start",
  runId: "run-1",
};

describe("RunnerManager", () => {
  beforeEach(() => {
    forkMock.mockReset();
    forkMock.mockImplementation(() => new MockChildProcess());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forks the runner as a sibling file of the worker entry, not the worker entry itself", async () => {
    const client = makeClient();
    const manager = makeManager(client);

    await manager.handle(userMessage);

    const [runnerEntryPath] = forkMock.mock.calls[0] as [string, ...unknown[]];
    const workerEntryPath = process.argv[1];
    expect(workerEntryPath).toBeDefined();
    expect(runnerEntryPath).not.toBe(workerEntryPath);
    expect(dirname(runnerEntryPath)).toBe(dirname(workerEntryPath as string));
    expect(runnerEntryPath).toBe(
      join(dirname(workerEntryPath as string), `runner${extname(workerEntryPath as string)}`)
    );
  });

  it("does not leak the worker's own server credentials into the runner env", async () => {
    vi.stubEnv("AGEWORK_WORKER_API_BASE", "http://internal-server:3000");
    vi.stubEnv("AGEWORK_WORKER_START_TOKEN", "super-secret-token");
    vi.stubEnv("AGEWORK_PRIVATE_DATABASE_URL", "postgres://should-never-leak");
    vi.stubEnv("AGEWORK_WORKER_LOG_LEVEL", "debug");

    const client = makeClient();
    const manager = makeManager(client);

    await manager.handle(userMessage);

    const [, , options] = forkMock.mock.calls[0] as [
      string,
      unknown,
      { env: NodeJS.ProcessEnv },
    ];
    expect(options.env).not.toHaveProperty("AGEWORK_WORKER_API_BASE");
    expect(options.env).not.toHaveProperty("AGEWORK_WORKER_START_TOKEN");
    expect(options.env).not.toHaveProperty("AGEWORK_PRIVATE_DATABASE_URL");
    expect(options.env.AGEWORK_WORKER_LOG_LEVEL).toBe("debug");
  });

  it("starts one runner process for a user_message command", async () => {
    const config = makeRunConfig();
    const client = makeClient(config);
    const manager = makeManager(client);

    await manager.handle(userMessage);

    expect(client.fetchRunConfig).toHaveBeenCalledWith("run-1");
    expect(forkMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          AGEWORK_WORKER_ROLE: "runner",
          AGEWORK_WORKER_RUN_ID: "run-1",
          AGEWORK_WORKER_LOG_FILE: "/tmp/agework-run-1.log",
        }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
    );

    const child = forkMock.mock.results[0]?.value as MockChildProcess;
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        method: "run.config",
        params: {
          runId: "run-1",
          config,
        },
      }),
      expect.any(Function)
    );
    expect(client.emit).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: "command.result",
        payload: expect.objectContaining({
          commandId: "cmd-start",
          commandType: "user_message",
          status: "ok",
        }),
      })
    );
  });

  it("forwards run-scoped commands to the active runner process", async () => {
    const client = makeClient();
    const manager = makeManager(client);
    await manager.handle(userMessage);
    const child = forkMock.mock.results[0]?.value as MockChildProcess;
    child.send.mockClear();

    await manager.handle({
      type: "cancel",
      commandId: "cmd-cancel",
      runId: "run-1",
      conversationId: "conversation-1",
    });

    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: "cmd-cancel",
        method: "run.cancel",
        params: {
          runId: "run-1",
          conversationId: "conversation-1",
        },
      }),
      expect.any(Function)
    );
  });

  it("forwards runner terminal status and cleans the run slot", async () => {
    const client = makeClient();
    const manager = makeManager(client);
    await manager.handle(userMessage);
    const child = forkMock.mock.results[0]?.value as MockChildProcess;

    const statusMessage: UpstreamMessage = {
      runId: "run-1",
      seq: 0,
      type: "run.status",
      payload: { status: "finished" },
      ts: "",
    };
    child.emit("message", upstreamMessageToRpcNotification(statusMessage));

    await vi.waitFor(() => {
      expect(client.cleanup).toHaveBeenCalledWith("run-1");
    });
    expect(manager.size()).toBe(0);
    expect(client.emit).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        type: "run.status",
        payload: { status: "finished" },
      })
    );
  });

  it("forwards runner command results back to the run client", async () => {
    const client = makeClient();
    const manager = makeManager(client);
    await manager.handle(userMessage);
    const child = forkMock.mock.results[0]?.value as MockChildProcess;

    child.emit(
      "message",
      commandResultToRpcResponse({
        commandId: "cmd-cancel",
        ok: true,
        runId: "run-1",
        commandType: "cancel",
      })
    );

    await vi.waitFor(() => {
      expect(client.emit).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          type: "command.result",
          payload: expect.objectContaining({
            commandId: "cmd-cancel",
            commandType: "cancel",
            status: "ok",
          }),
        })
      );
    });
  });
});
