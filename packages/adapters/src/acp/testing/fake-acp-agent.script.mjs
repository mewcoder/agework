// Runnable fake ACP agent for tests. Plain ESM (not part of the TS build) so it
// can be spawned directly with `node fake-acp-agent.script.mjs` and speak real
// ACP over stdio via the official SDK. Behaviour is scripted through env vars:
//
//   FAKE_ACP_LOAD_SESSION=1    advertise loadSession capability
//   FAKE_ACP_RESUME=1          advertise sessionCapabilities.resume
//   FAKE_ACP_REPLY=<text>      assistant text reply (default "hello from fake acp")
//   FAKE_ACP_EMIT_THOUGHT=1    emit an agent_thought_chunk before the reply
//   FAKE_ACP_REQUEST_PERMISSION=1  request permission during the prompt turn
//   FAKE_ACP_STDERR=<line>     write a line to stderr on startup
//   FAKE_ACP_POLLUTE_STDOUT=1  write non-JSON garbage to stdout (protocol error)
//   FAKE_ACP_HANG=1            never respond to prompt (used for cancel/timeout)
import { agent, methods, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const env = process.env;
const reply = env.FAKE_ACP_REPLY ?? "hello from fake acp";

if (env.FAKE_ACP_STDERR) {
  process.stderr.write(env.FAKE_ACP_STDERR + "\n");
}
if (env.FAKE_ACP_POLLUTE_STDOUT) {
  // Emit invalid (non-NDJSON) bytes onto the ACP wire before anything else.
  process.stdout.write("this is not json-rpc\n");
}

let cancelled = false;

const app = agent()
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: env.FAKE_ACP_LOAD_SESSION === "1",
      ...(env.FAKE_ACP_RESUME === "1"
        ? { sessionCapabilities: { resume: {} } }
        : {}),
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    },
    agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
    authMethods: [],
  }))
  .onRequest(methods.agent.session.new, async () => ({
    sessionId: "fake-session-1",
  }))
  .onRequest(methods.agent.session.load, async () => ({}))
  .onRequest(methods.agent.session.resume, async () => ({}))
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const { sessionId } = ctx.params;
    if (env.FAKE_ACP_HANG === "1") {
      // Wait until cancelled (or the connection dies).
      await new Promise((resolve) => {
        ctx.signal.addEventListener("abort", resolve, { once: true });
      });
      return { stopReason: "cancelled" };
    }

    if (env.FAKE_ACP_EMIT_THOUGHT === "1") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking..." },
        },
      });
    }

    if (env.FAKE_ACP_REQUEST_PERMISSION === "1") {
      const res = await ctx.client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
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
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply },
      },
    });

    return { stopReason: cancelled ? "cancelled" : "end_turn" };
  })
  .onNotification(methods.agent.session.cancel, async () => {
    cancelled = true;
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);
app.connect(stream);
