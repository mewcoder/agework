import { BadRequestException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "./http-exception.filter";

describe("AllExceptionsFilter", () => {
  it("returns requestId and preserves incoming x-request-id", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new BadRequestException("bad input"),
      mockHost({
        response,
        headers: { "x-request-id": "req-1" },
      })
    );

    expect(response.setHeader).toHaveBeenCalledWith("x-request-id", "req-1");
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      data: null,
      message: "bad input",
      requestId: "req-1",
    });
  });

  it("logs 5xx exceptions with request context", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();
    const logger = filter as unknown as {
      logger: { error: ReturnType<typeof vi.fn> };
    };
    logger.logger.error = vi.fn();

    filter.catch(
      new Error("boom"),
      mockHost({
        response,
        headers: {},
        method: "POST",
        originalUrl: "/api/v1/runs",
      })
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(logger.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"method":"POST"')
    );
    expect(logger.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"path":"/api/v1/runs"')
    );
    expect(logger.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('"errorMessage":"boom"')
    );
  });
});

function mockResponse() {
  return {
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

function mockHost(input: {
  response: ReturnType<typeof mockResponse>;
  headers: Record<string, string>;
  method?: string;
  originalUrl?: string;
}): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => input.response,
      getRequest: () => ({
        headers: input.headers,
        method: input.method ?? "GET",
        originalUrl: input.originalUrl ?? "/test",
        url: input.originalUrl ?? "/test",
      }),
    }),
  } as ArgumentsHost;
}
