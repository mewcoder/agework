import { describe, expect, it } from "vitest";
import type { RunChannelMessage } from "./run-channel-message";
import type {
  RunConfig,
  RunChannel,
  CommandPayload,
  UpstreamMessage,
} from "./channel";

describe("RunChannel contract", () => {
  it("RunConfig carries runtimePath and env for the worker", () => {
    const config: RunConfig = {
      runId: "run-1",
      conversationId: "conversation-1",
      workspaceId: "ws-1",
      runtimePath: "/tmp/workspace",
      env: { FOO: "bar" },
      input: { foo: "bar" },
      agentProviderConfig: {
        agentType: "claude",
        source: "custom",
        apiKey: "sk-test",
        baseUrl: "https://example.com",
        model: "claude-test",
      },
    };

    expect(config.runtimePath).toBe("/tmp/workspace");
    expect(config.env.FOO).toBe("bar");
    expect(config.agentProviderConfig.agentType).toBe("claude");
  });

  it("a RunChannel implementation can fetch config, emit upstream messages and subscribe commands", async () => {
    const sent: UpstreamMessage[] = [];
    let commandHandler: ((c: RunChannelMessage<CommandPayload>) => void) | undefined;

    const transport: RunChannel = {
      fetchRunConfig: () =>
        Promise.resolve({
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
          runtimePath: "/tmp/workspace",
          env: {},
          input: {},
          agentProviderConfig: { agentType: "claude" as const, source: "system" },
        }),
      emit: (msg) => {
        sent.push(msg);
        return Promise.resolve();
      },
      subscribeCommands: (cb) => {
        commandHandler = cb;
        return () => {
          commandHandler = undefined;
        };
      },
      close: () => Promise.resolve(),
    };

    const config = await transport.fetchRunConfig();
    expect(config.runId).toBe("run-1");

    await transport.emit({
      runId: "run-1",
      seq: 1,
      type: "run.status",
      payload: { status: "running" },
      ts: new Date().toISOString(),
    });
    expect(sent).toHaveLength(1);

    const unsubscribe = transport.subscribeCommands(() => {});
    expect(commandHandler).toBeTypeOf("function");
    unsubscribe();
    expect(commandHandler).toBeUndefined();

    await transport.close();
  });
});
