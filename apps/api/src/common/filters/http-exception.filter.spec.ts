import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
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

  it("joins validation error arrays into one message", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new BadRequestException({
        message: ["name must be a string", "pageNo must be an integer"],
      }),
      mockHost({ response, headers: { "x-request-id": "req-validation" } })
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      data: null,
      message: "name must be a string; pageNo must be an integer",
      requestId: "req-validation",
    });
  });

  it("uses object error field when message is absent", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new HttpException({ error: "Custom bad request" }, 400),
      mockHost({ response, headers: { "x-request-id": "req-object" } })
    );

    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      data: null,
      message: "Custom bad request",
      requestId: "req-object",
    });
  });

  it("uses string HttpException response as message", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new HttpException("plain bad request", 400),
      mockHost({ response, headers: { "x-request-id": "req-string" } })
    );

    expect(response.json).toHaveBeenCalledWith({
      code: 400,
      data: null,
      message: "plain bad request",
      requestId: "req-string",
    });
  });

  it("does not expose unexpected Error messages to clients", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new Error("database password=secret-token exploded"),
      mockHost({ response, headers: { "x-request-id": "req-500" } })
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      code: 500,
      data: null,
      message: "Internal server error",
      requestId: "req-500",
    });
  });

  it("generates requestId when x-request-id is absent", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(new BadRequestException("bad"), mockHost({ response }));

    expect(response.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      expect.any(String)
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: expect.any(String) })
    );
  });

  it("uses the first non-empty x-request-id header value", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();

    filter.catch(
      new BadRequestException("bad"),
      mockHost({ response, headers: { "x-request-id": ["", "req-array"] } })
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      "x-request-id",
      "req-array"
    );
  });

  it("does nothing once response headers were already sent", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse({ headersSent: true });

    filter.catch(new BadRequestException("bad"), mockHost({ response }));

    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it("logs 5xx exceptions with request context and redacted sensitive values", () => {
    const filter = new AllExceptionsFilter();
    const response = mockResponse();
    const logger = mockFilterLogger(filter);

    filter.catch(
      new Error(
        "boom password=hunter2 token=abc apiKey=key-123 cookie=session"
      ),
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
      expect.stringContaining('"errorMessage":"boom password=[redacted]')
    );
    const logMessage = logger.logger.error.mock.calls[0][0];
    expect(logMessage).not.toContain("hunter2");
    expect(logMessage).not.toContain("abc");
    expect(logMessage).not.toContain("key-123");
    expect(logMessage).not.toContain("session");
  });

  it("uses expected log levels for common 4xx statuses", () => {
    const cases = [
      { exception: new BadRequestException("bad"), level: "debug" },
      { exception: new UnauthorizedException(), level: "debug" },
      { exception: new NotFoundException(), level: "debug" },
      { exception: new ForbiddenException(), level: "warn" },
      { exception: new HttpException("too many", 429), level: "warn" },
    ] as const;

    for (const item of cases) {
      const filter = new AllExceptionsFilter();
      const response = mockResponse();
      const logger = mockFilterLogger(filter);

      filter.catch(
        item.exception,
        mockHost({ response, headers: { "x-request-id": item.level } })
      );

      expect(logger.logger[item.level]).toHaveBeenCalledWith(
        expect.stringContaining("request rejected")
      );
      for (const otherLevel of ["debug", "warn", "error"] as const) {
        if (otherLevel !== item.level) {
          expect(logger.logger[otherLevel]).not.toHaveBeenCalled();
        }
      }
    }
  });
});

function mockFilterLogger(filter: AllExceptionsFilter) {
  const instance = filter as unknown as {
    logger: {
      debug: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  };
  instance.logger.debug = vi.fn();
  instance.logger.warn = vi.fn();
  instance.logger.error = vi.fn();
  return instance;
}

function mockResponse(input: { headersSent?: boolean } = {}) {
  return {
    headersSent: input.headersSent ?? false,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

function mockHost(input: {
  response: ReturnType<typeof mockResponse>;
  headers?: Record<string, string | string[]>;
  method?: string;
  originalUrl?: string;
}): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => input.response,
      getRequest: () => ({
        headers: input.headers ?? {},
        method: input.method ?? "GET",
        originalUrl: input.originalUrl ?? "/test",
        url: input.originalUrl ?? "/test",
      }),
    }),
  } as ArgumentsHost;
}
