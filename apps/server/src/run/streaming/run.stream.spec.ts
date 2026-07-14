import { describe, it, expect, vi } from "vitest";
import type { Response } from "express";
import { RunStream } from "./run.stream";

function makeRes(writableLength = 0) {
  const res = {
    writableEnded: false,
    writableLength,
    setHeader: vi.fn(),
    status: vi.fn(),
    on: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
  };
  return res;
}

describe("RunStream backpressure", () => {
  it("writes SSE data without ending under a normal buffer", () => {
    const res = makeRes(0);
    const stream = new RunStream(res as unknown as Response);

    stream.writeEvent({ type: "X" });

    expect(res.write).toHaveBeenCalledWith('data: {"type":"X"}\n\n');
    expect(res.end).not.toHaveBeenCalled();
  });

  it("ends the connection when the send buffer exceeds the cap", () => {
    const res = makeRes(9 * 1024 * 1024);
    const stream = new RunStream(res as unknown as Response);

    stream.writeEvent({ type: "X" });

    expect(res.end).toHaveBeenCalled();
  });

  it("no-ops further writes after the connection was ended", () => {
    const res = makeRes(9 * 1024 * 1024);
    const stream = new RunStream(res as unknown as Response);
    stream.writeEvent({ type: "X" }); // 触发 end
    res.write.mockClear();

    stream.writeEvent({ type: "Y" });

    expect(res.write).not.toHaveBeenCalled();
  });
});
