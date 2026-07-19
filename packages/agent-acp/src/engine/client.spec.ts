import { describe, it, expect } from "vitest";
import { AcpConnection, type AcpSessionUpdate } from "./client";
import { AcpError } from "./errors";
import { loadAcpSdk } from "./sdk";
import { createFakeAgentApp, type FakeScenario } from "../testing/fake-agent-app";

async function connect(scenario: FakeScenario = {}): Promise<AcpConnection> {
  const sdk = await loadAcpSdk();
  const agentApp = createFakeAgentApp(sdk, scenario);
  return AcpConnection.initialize({
    target: agentApp,
    clientInfo: { name: "agework-test", version: "0.0.0" },
  });
}

async function withConnection(
  scenario: FakeScenario,
  fn: (conn: AcpConnection) => Promise<void>
): Promise<void> {
  const conn = await connect(scenario);
  try {
    await fn(conn);
  } finally {
    conn.close();
    await conn.closed;
  }
}

describe("AcpConnection", () => {
  it("initializes and normalizes capabilities", async () => {
    await withConnection({ loadSession: true, resume: true }, async (conn) => {
      const caps = conn.capabilities;
      expect(caps.protocolVersion).toBe(1);
      expect(caps.loadSession).toBe(true);
      expect(caps.resumeSession).toBe(true);
      expect(caps.promptCapabilities.image).toBe(false);
    });
  });

  it("reports no resume/load when the agent advertises neither", async () => {
    await withConnection({}, async (conn) => {
      expect(conn.capabilities.loadSession).toBe(false);
      expect(conn.capabilities.resumeSession).toBe(false);
    });
  });

  it("rejects an incompatible protocol version", async () => {
    await expect(connect({ badProtocolVersion: 2 })).rejects.toMatchObject({
      code: "ACP_VERSION_UNSUPPORTED",
    } satisfies Partial<AcpError>);
  });

  it("routes session/update notifications to the registered session handler", async () => {
    await withConnection({ reply: "routed" }, async (conn) => {
      const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      const updates: AcpSessionUpdate[] = [];
      conn.registerSession(sessionId, (u) => updates.push(u));

      await conn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

      const texts = updates
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as { content: { text: string } }).content.text);
      expect(texts).toContain("routed");
    });
  });

  it("declines permission requests when no bridge is installed", async () => {
    await withConnection({ requestPermission: true }, async (conn) => {
      const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      const res = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "do it" }],
      });
      // Agent asked permission → default handler cancelled → agent stops cancelled.
      expect(res.stopReason).toBe("cancelled");
    });
  });

  it("uses the installed permission handler's decision", async () => {
    await withConnection({ requestPermission: true, reply: "done" }, async (conn) => {
      conn.setPermissionHandler(async () => ({
        outcome: { outcome: "selected", optionId: "allow-once" },
      }));
      const { sessionId } = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
      const res = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: "do it" }],
      });
      expect(res.stopReason).toBe("end_turn");
    });
  });
});
