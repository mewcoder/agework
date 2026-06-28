import { describe, expect, it, vi } from "vitest";
import {
  REQUEST_ID_HEADER,
  requestIdFromHeaders,
  requestIdMiddleware,
  resolveRequestId,
} from "./request-id";

describe("requestIdFromHeaders", () => {
  it("returns a trimmed string request id", () => {
    expect(
      requestIdFromHeaders({ [REQUEST_ID_HEADER]: " request-1 " })
    ).toBe("request-1");
  });

  it("returns the first non-empty array value", () => {
    expect(
      requestIdFromHeaders({ [REQUEST_ID_HEADER]: ["", " request-2 "] })
    ).toBe("request-2");
  });

  it("returns undefined when no request id is present", () => {
    expect(requestIdFromHeaders({})).toBeUndefined();
  });
});

describe("resolveRequestId", () => {
  it("preserves incoming request id", () => {
    expect(
      resolveRequestId({
        headers: { [REQUEST_ID_HEADER]: "request-1" },
      } as never)
    ).toBe("request-1");
  });

  it("generates a request id when missing", () => {
    expect(resolveRequestId({ headers: {} } as never)).toEqual(
      expect.any(String)
    );
  });
});

describe("requestIdMiddleware", () => {
  it("sets x-request-id on request and response", () => {
    const req = { headers: { [REQUEST_ID_HEADER]: " request-1 " } };
    const res = { setHeader: vi.fn() };
    const next = vi.fn();

    requestIdMiddleware()(req as never, res as never, next);

    expect(req.headers[REQUEST_ID_HEADER]).toBe("request-1");
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      "request-1"
    );
    expect(next).toHaveBeenCalledWith();
  });

  it("generates x-request-id when absent", () => {
    const req = { headers: {} as Record<string, string> };
    const res = { setHeader: vi.fn() };
    const next = vi.fn();

    requestIdMiddleware()(req as never, res as never, next);

    expect(req.headers[REQUEST_ID_HEADER]).toEqual(expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      req.headers[REQUEST_ID_HEADER]
    );
    expect(next).toHaveBeenCalledWith();
  });
});
