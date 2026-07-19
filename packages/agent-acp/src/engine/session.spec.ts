import { describe, it, expect } from "vitest";
import { AcpConnection, type AcpSessionUpdate } from "./client";
import { AcpSession } from "./session";
import { loadAcpSdk } from "./sdk";
import { createFakeAgentApp, type FakeScenario } from "../testing/fake-agent-app";

async function connect(scenario: FakeScenario): Promise<AcpConnection> {
  const sdk = await loadAcpSdk();
  return AcpConnection.initialize({
    target: createFakeAgentApp(sdk, scenario),
    clientInfo: { name: "agework-test", version: "0.0.0" },
  });
}

const collector = () => {
  const live: AcpSessionUpdate[] = [];
  const replay: AcpSessionUpdate[] = [];
  return {
    live,
    replay,
    onUpdate: (u: AcpSessionUpdate) => live.push(u),
    onReplayUpdate: (u: AcpSessionUpdate) => replay.push(u),
  };
};

describe("AcpSession", () => {
  it("creates a fresh session when no existing id is given", async () => {
    const calls: string[] = [];
    const conn = await connect({ calls });
    try {
      const c = collector();
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        onUpdate: c.onUpdate,
      });
      expect(session.sessionId).toBe("fake-session-1");
      expect(session.isNew).toBe(true);
      expect(calls).toContain("session/new");
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("prefers session/resume over session/load when both are supported", async () => {
    const calls: string[] = [];
    const conn = await connect({ resume: true, loadSession: true, calls });
    try {
      const c = collector();
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        existingSessionId: "prev-1",
        onUpdate: c.onUpdate,
      });
      expect(session.sessionId).toBe("prev-1");
      expect(session.isNew).toBe(false);
      expect(calls).toContain("session/resume");
      expect(calls).not.toContain("session/load");
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("suppresses replayed history during session/load", async () => {
    const conn = await connect({ loadSession: true, loadEmitsHistory: true, reply: "live reply" });
    try {
      const c = collector();
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        existingSessionId: "prev-1",
        onUpdate: c.onUpdate,
        onReplayUpdate: c.onReplayUpdate,
      });
      // History streamed during load went to replay, not live output.
      expect(c.replay.length).toBe(2);
      expect(c.live.length).toBe(0);

      // A subsequent prompt is live, not replay.
      await session.prompt([{ type: "text", text: "hi" }]);
      const liveTexts = c.live
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as { content: { text: string } }).content.text);
      expect(liveTexts).toContain("live reply");
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("suppresses history replayed on session/resume until our prompt is sent", async () => {
    const conn = await connect({ resume: true, resumeEmitsHistory: true, reply: "new answer" });
    try {
      const c = collector();
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        existingSessionId: "prev-1",
        onUpdate: c.onUpdate,
        onReplayUpdate: c.onReplayUpdate,
      });
      // The prior answer replayed on resume must NOT leak as live output.
      expect(c.live.length).toBe(0);
      expect(c.replay.length).toBe(1);

      await session.prompt([{ type: "text", text: "second question" }]);
      const liveTexts = c.live
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as { content: { text: string } }).content.text);
      expect(liveTexts).toEqual(["new answer"]);
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("fails with ACP_SESSION_NOT_FOUND when resume/load rejects", async () => {
    const conn = await connect({ resume: true, sessionNotFound: true });
    try {
      await expect(
        AcpSession.start({
          connection: conn,
          cwd: "/tmp",
          existingSessionId: "gone",
          onUpdate: () => {},
        })
      ).rejects.toMatchObject({ code: "ACP_SESSION_NOT_FOUND" });
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("fails with ACP_SESSION_RESUME_UNSUPPORTED when the agent supports neither", async () => {
    const conn = await connect({});
    try {
      await expect(
        AcpSession.start({
          connection: conn,
          cwd: "/tmp",
          existingSessionId: "prev-1",
          onUpdate: () => {},
        })
      ).rejects.toMatchObject({ code: "ACP_SESSION_RESUME_UNSUPPORTED" });
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("returns the prompt stop reason", async () => {
    const conn = await connect({ reply: "ok" });
    try {
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        onUpdate: () => {},
      });
      const res = await session.prompt([{ type: "text", text: "hi" }]);
      expect(res.stopReason).toBe("end_turn");
    } finally {
      conn.close();
      await conn.closed;
    }
  });

  it("cancel() releases an in-flight prompt turn", async () => {
    const conn = await connect({ hangUntilCancel: true });
    try {
      const session = await AcpSession.start({
        connection: conn,
        cwd: "/tmp",
        onUpdate: () => {},
      });
      const pending = session.prompt([{ type: "text", text: "long task" }]);
      await session.cancel();
      const res = await pending;
      expect(res.stopReason).toBe("cancelled");
    } finally {
      conn.close();
      await conn.closed;
    }
  });
});
