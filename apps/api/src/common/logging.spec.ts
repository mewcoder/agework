import { describe, it, expect, afterEach } from "vitest";
import {
  errorLogFields,
  safeLogJson,
  redactLogValue,
  summarizeEnvelopePayload,
  resolveNestLogLevels,
} from "./logging";

describe("errorLogFields", () => {
  it("extracts name, message, stack from Error", () => {
    const error = new Error("boom");
    const fields = errorLogFields(error);
    expect(fields.errorName).toBe("Error");
    expect(fields.errorMessage).toBe("boom");
    expect(typeof fields.stack).toBe("string");
  });

  it("converts non-Error to string", () => {
    expect(errorLogFields("oops")).toEqual({ errorMessage: "oops" });
    expect(errorLogFields(42)).toEqual({ errorMessage: "42" });
    expect(errorLogFields(null)).toEqual({ errorMessage: "null" });
  });
});

describe("safeLogJson", () => {
  it("serializes plain objects", () => {
    expect(safeLogJson({ a: 1 })).toBe('{"a":1}');
  });

  it("redacts sensitive keys", () => {
    expect(safeLogJson({ api_key: "secret", password: "pw" })).toBe(
      '{"api_key":"[redacted]","password":"[redacted]"}'
    );
  });

  it("returns String(value) on serialization failure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeLogJson(circular)).toContain("[circular]");
  });
});

describe("redactLogValue", () => {
  it("redacts keys matching secret pattern", () => {
    expect(redactLogValue({ authorization: "Bearer xyz" })).toEqual({
      authorization: "[redacted]",
    });
    expect(redactLogValue({ token: "abc" })).toEqual({ token: "[redacted]" });
    expect(redactLogValue({ jwt: "xxx" })).toEqual({ jwt: "[redacted]" });
  });

  it("preserves non-sensitive keys", () => {
    expect(redactLogValue({ name: "alice", age: 30 })).toEqual({
      name: "alice",
      age: 30,
    });
  });

  it("handles arrays", () => {
    expect(redactLogValue([1, "two"])).toEqual([1, "two"]);
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(redactLogValue(obj)).toEqual({ self: "[circular]" });
  });

  it("converts Date to ISO string", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(redactLogValue(date)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("converts BigInt to string", () => {
    expect(redactLogValue(BigInt(123))).toBe("123");
  });

  it("redacts nested sensitive keys", () => {
    expect(redactLogValue({ user: { password: "pw" } })).toEqual({
      user: { password: "[redacted]" },
    });
  });
});

describe("summarizeEnvelopePayload", () => {
  it("extracts known fields from object payload", () => {
    expect(
      summarizeEnvelopePayload({
        type: "run.status",
        status: "running",
        name: "test",
        pendingAction: null,
        extra: "ignored",
      })
    ).toEqual({
      type: "run.status",
      status: "running",
      name: "test",
      pendingAction: null,
    });
  });

  it("wraps non-object payload", () => {
    expect(summarizeEnvelopePayload("hello")).toEqual({ value: "hello" });
    expect(summarizeEnvelopePayload(null)).toEqual({ value: "null" });
    expect(summarizeEnvelopePayload(42)).toEqual({ value: "42" });
  });
});

describe("resolveNestLogLevels", () => {
  const originalEnv = {
    AGEWORK_LOG_LEVEL: process.env.AGEWORK_LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    restoreEnv("AGEWORK_LOG_LEVEL", originalEnv.AGEWORK_LOG_LEVEL);
    restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  });

  it("returns debug levels for debug setting", () => {
    process.env.AGEWORK_LOG_LEVEL = "debug";
    expect(resolveNestLogLevels()).toEqual(["error", "warn", "log", "debug"]);
  });

  it("returns warn levels for warn setting", () => {
    process.env.AGEWORK_LOG_LEVEL = "warn";
    expect(resolveNestLogLevels()).toEqual(["error", "warn"]);
  });

  it("returns error only for error setting", () => {
    process.env.AGEWORK_LOG_LEVEL = "error";
    expect(resolveNestLogLevels()).toEqual(["error"]);
  });

  it("returns verbose levels for verbose setting", () => {
    process.env.AGEWORK_LOG_LEVEL = "verbose";
    expect(resolveNestLogLevels()).toEqual([
      "error",
      "warn",
      "log",
      "debug",
      "verbose",
    ]);
  });

  it("defaults to debug in non-production", () => {
    delete process.env.AGEWORK_LOG_LEVEL;
    process.env.NODE_ENV = "development";
    expect(resolveNestLogLevels()).toEqual(["error", "warn", "log", "debug"]);
  });

  it("defaults to no-debug in production", () => {
    delete process.env.AGEWORK_LOG_LEVEL;
    process.env.NODE_ENV = "production";
    expect(resolveNestLogLevels()).toEqual(["error", "warn", "log"]);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
