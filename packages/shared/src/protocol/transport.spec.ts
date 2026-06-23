import type { Envelope } from "./envelope";
import type {
  RunConfig,
  RuntimeTransport,
  ControlPayload,
  UpstreamMessage,
} from "./transport";

describe("RuntimeTransport contract", () => {
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

  it("a RuntimeTransport implementation can fetch config, emit upstream messages and subscribe controls", async () => {
    const sent: UpstreamMessage[] = [];
    let controlHandler: ((c: Envelope<ControlPayload>) => void) | undefined;

    const transport: RuntimeTransport = {
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
      subscribeControls: (cb) => {
        controlHandler = cb;
        return () => {
          controlHandler = undefined;
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

    const unsubscribe = transport.subscribeControls(() => {});
    expect(controlHandler).toBeTypeOf("function");
    unsubscribe();
    expect(controlHandler).toBeUndefined();

    await transport.close();
  });
});
