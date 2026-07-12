import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { AcpProcess, type AcpProcessOptions } from "./acp-process";
import { createStdioStream } from "./stdio-stream";
import { loadAcpSdk } from "../sdk";
import { FAKE_ACP_AGENT_PATH } from "../testing/fake-acp-agent";

const NODE = process.execPath;

function nodeProc(
  script: string,
  overrides: Partial<AcpProcessOptions> = {}
): AcpProcess {
  return new AcpProcess({
    command: NODE,
    args: ["-e", script],
    cwd: process.cwd(),
    env: {},
    ...overrides,
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe("AcpProcess", () => {
  it("resolves the exit code of a normal process", async () => {
    const proc = nodeProc("process.exit(0)");
    proc.start();
    const exit = await proc.exit;
    expect(exit.code).toBe(0);
    expect(proc.hasExited).toBe(true);
  });

  it("launches the child with the given cwd and env, without inheriting", async () => {
    const dir = realpathSync(tmpdir());
    const script =
      "process.stderr.write('CWD='+process.cwd()+'|FOO='+process.env.FOO+'|HOME='+process.env.HOME+'\\n')";
    const proc = new AcpProcess({
      command: NODE,
      args: ["-e", script],
      cwd: dir,
      env: { FOO: "acp-test-value" },
    });
    proc.start();
    await proc.exit;
    const stderr = proc.recentStderr().join("\n");
    expect(stderr).toContain("CWD=" + dir);
    expect(stderr).toContain("FOO=acp-test-value");
    expect(stderr).toContain("HOME=undefined");
  });

  it("keeps stdout (the ACP wire) and stderr strictly separated", async () => {
    const proc = nodeProc(
      "process.stdout.write('WIRE_BYTES'); process.stderr.write('LOG_LINE\\n')"
    );
    proc.start();
    const stdout = await readAll(proc.stdout);
    await proc.exit;
    const stderr = proc.recentStderr().join("\n");

    expect(stdout).toBe("WIRE_BYTES");
    expect(stdout).not.toContain("LOG_LINE");
    expect(stderr).toContain("LOG_LINE");
    expect(stderr).not.toContain("WIRE_BYTES");
  });

  it("terminate() stops a long-running process", async () => {
    const proc = nodeProc("setInterval(() => {}, 1000)");
    proc.start();
    await proc.terminate();
    const exit = await proc.exit;
    expect(proc.hasExited).toBe(true);
    expect(exit.signal === "SIGTERM" || exit.code !== null).toBe(true);
  });

  it("terminate() is idempotent", async () => {
    const proc = nodeProc("setInterval(() => {}, 1000)");
    proc.start();
    await Promise.all([proc.terminate(), proc.terminate(), proc.terminate()]);
    expect(proc.hasExited).toBe(true);
  });

  it("captures a spawn failure instead of throwing", async () => {
    const proc = new AcpProcess({
      command: "definitely-not-a-real-binary-xyz-123",
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    proc.start();
    await proc.exit;
    expect(proc.error).toBeInstanceOf(Error);
    expect(proc.hasExited).toBe(true);
  });

  it("throws when started twice", () => {
    const proc = nodeProc("process.exit(0)");
    proc.start();
    expect(() => proc.start()).toThrow(/already started/);
  });

  it("end-to-end: a spawned fake ACP agent completes the initialize handshake", async () => {
    const proc = new AcpProcess({
      command: NODE,
      args: [FAKE_ACP_AGENT_PATH],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
    });
    proc.start();

    const stream = await createStdioStream(proc.stdin, proc.stdout);
    const { client, methods, PROTOCOL_VERSION } = await loadAcpSdk();

    const conn = client().connect(stream);
    const res = await conn.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    conn.close();
    await conn.closed;
    await proc.terminate();
  });
});
