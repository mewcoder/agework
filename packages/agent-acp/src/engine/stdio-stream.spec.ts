import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
import { createStdioStream } from "./stdio-stream";

/** Collect chunks emitted on a node stream until a short quiet period. */
function collect(stream: PassThrough): () => string {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  return () => Buffer.concat(chunks).toString("utf8");
}

describe("createStdioStream", () => {
  it("encodes outgoing messages as newline-delimited JSON on stdin", async () => {
    const toAgent = new PassThrough(); // we write here → agent reads
    const fromAgent = new PassThrough(); // agent writes here → we read
    const readToAgent = collect(toAgent);

    const stream = await createStdioStream(toAgent, fromAgent);

    const outMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    };
    const writer = stream.writable.getWriter();
    await writer.write(outMsg as never);

    await new Promise((r) => setTimeout(r, 20));
    const written = readToAgent();
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written.trim())).toMatchObject(outMsg);
  });

  it("decodes incoming newline-delimited JSON from stdout", async () => {
    const toAgent = new PassThrough();
    const fromAgent = new PassThrough();

    const stream = await createStdioStream(toAgent, fromAgent);

    const inMsg = { jsonrpc: "2.0", id: 1, result: { ok: true } };
    fromAgent.write(JSON.stringify(inMsg) + "\n");

    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value).toMatchObject(inMsg);
  });
});
