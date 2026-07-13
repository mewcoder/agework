import { describe, it, expect, afterEach } from "vitest";
import {
  errorLogFields,
  safeLogJson,
  redactLogValue,
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

  it("redacts sensitive values embedded in log strings", () => {
    const json = safeLogJson({
      message:
        "failed password=hunter2 token=abc apiKey=key-123 cookie=session authorization=Bearer xyz",
    });

    expect(json).toContain("password=[redacted]");
    expect(json).toContain("token=[redacted]");
    expect(json).toContain("apiKey=[redacted]");
    expect(json).toContain("cookie=[redacted]");
    expect(json).toContain("authorization=[redacted]");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abc");
    expect(json).not.toContain("key-123");
    expect(json).not.toContain("session");
    expect(json).not.toContain("xyz");
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

describe("resolveNestLogLevels", () => {
  const originalEnv = {
    AGEWORK_LOG_LEVEL: process.env.AGEWORK_LOG_LEVEL,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    restoreEnv("AGEWORK_LOG_LEVEL", originalEnv.AGEWORK_LOG_LEVEL);
    restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
  });

  it("error → fatal+error", () => {
    process.env.AGEWORK_LOG_LEVEL = "error";
    expect(resolveNestLogLevels()).toEqual(["fatal", "error"]);
  });

  it("warn → +warn", () => {
    process.env.AGEWORK_LOG_LEVEL = "warn";
    expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn"]);
  });

  it("info → +log", () => {
    process.env.AGEWORK_LOG_LEVEL = "info";
    expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log"]);
  });

  it("debug → +debug", () => {
    process.env.AGEWORK_LOG_LEVEL = "debug";
    expect(resolveNestLogLevels()).toEqual([
      "fatal",
      "error",
      "warn",
      "log",
      "debug",
    ]);
  });

  it("trace → all", () => {
    process.env.AGEWORK_LOG_LEVEL = "trace";
    expect(resolveNestLogLevels()).toEqual([
      "fatal",
      "error",
      "warn",
      "log",
      "debug",
      "verbose",
    ]);
  });

  it("verbose alias → all", () => {
    process.env.AGEWORK_LOG_LEVEL = "verbose";
    expect(resolveNestLogLevels()).toEqual([
      "fatal",
      "error",
      "warn",
      "log",
      "debug",
      "verbose",
    ]);
  });

  it("defaults to info regardless of NODE_ENV", () => {
    delete process.env.AGEWORK_LOG_LEVEL;
    process.env.NODE_ENV = "development";
    expect(resolveNestLogLevels()).toEqual(["fatal", "error", "warn", "log"]);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
