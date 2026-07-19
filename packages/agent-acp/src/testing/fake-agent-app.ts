import type { AgentApp } from "@agentclientprotocol/sdk";
import type { AcpSdk } from "../engine/sdk";

/** Scenario knobs for the in-process fake ACP agent used in client/session tests. */
export type FakeScenario = {
  loadSession?: boolean;
  resume?: boolean;
  sessionId?: string;
  reply?: string;
  emitThought?: boolean;
  emitTool?: boolean;
  /** Emit user/agent history chunks during `session/load` (to test replay suppression). */
  loadEmitsHistory?: boolean;
  /** Emit a prior-answer history chunk during `session/resume` (to test replay suppression). */
  resumeEmitsHistory?: boolean;
  /** Make `session/load` and `session/resume` fail. */
  sessionNotFound?: boolean;
  /** Request permission during the prompt turn before replying. */
  requestPermission?: boolean;
  /** Block the prompt turn until cancelled. */
  hangUntilCancel?: boolean;
  /** Return this protocol version from `initialize` (to test version mismatch). */
  badProtocolVersion?: number;
  /** If provided, each handled agent method name is pushed here (call order assertions). */
  calls?: string[];
};

/**
 * Build an in-process ACP agent (`AgentApp`) with scripted behaviour. Pass it as
 * the connect target to {@link AcpConnection.initialize} for hermetic, fast tests
 * without spawning a subprocess.
 */
export function createFakeAgentApp(sdk: AcpSdk, scenario: FakeScenario = {}): AgentApp {
  const { agent, methods, PROTOCOL_VERSION, RequestError } = sdk;
  const sessionId = scenario.sessionId ?? "fake-session-1";
  const reply = scenario.reply ?? "hello from fake acp";
  let cancelled = false;
  let releaseHang: (() => void) | undefined;
  const track = (m: string) => scenario.calls?.push(m);

  return agent()
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: scenario.badProtocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: scenario.loadSession === true,
        ...(scenario.resume ? { sessionCapabilities: { resume: {} } } : {}),
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
      },
      agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async () => {
      track("session/new");
      return { sessionId };
    })
    .onRequest(methods.agent.session.load, async (ctx) => {
      track("session/load");
      if (scenario.sessionNotFound) {
        throw new RequestError(-32000, "session not found");
      }
      if (scenario.loadEmitsHistory) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "old user message" },
          },
        });
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "old assistant reply" },
          },
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.resume, async (ctx) => {
      track("session/resume");
      if (scenario.sessionNotFound) {
        throw new RequestError(-32000, "session not found");
      }
      if (scenario.resumeEmitsHistory) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "prior answer" },
          },
        });
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      track("session/prompt");
      const sid = ctx.params.sessionId;
      if (scenario.hangUntilCancel) {
        // Block until a `session/cancel` notification releases us.
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { stopReason: "cancelled" };
      }
      if (scenario.emitThought) {
        await ctx.client.notify(methods.client.session.update, {
          sessionId: sid,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "thinking..." },
          },
        });
      }
      if (scenario.requestPermission) {
        const res = await ctx.client.request(
          methods.client.session.requestPermission,
          {
            sessionId: sid,
            toolCall: { toolCallId: "call-1", title: "Run a command" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          }
        );
        if (res.outcome.outcome === "cancelled") {
          return { stopReason: "cancelled" };
        }
      }
      await ctx.client.notify(methods.client.session.update, {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
        },
      });
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    })
    .onNotification(methods.agent.session.cancel, async () => {
      cancelled = true;
      releaseHang?.();
      releaseHang = undefined;
    });
}
