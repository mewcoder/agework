import { describe, it, expect, afterEach } from "vitest";
import { isDevAuthDisabled } from "./dev-auth";

describe("isDevAuthDisabled", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    AGEWORK_DEV_AUTH_DISABLED: process.env.AGEWORK_DEV_AUTH_DISABLED,
  };

  afterEach(() => {
    restoreEnv("NODE_ENV", originalEnv.NODE_ENV);
    restoreEnv(
      "AGEWORK_DEV_AUTH_DISABLED",
      originalEnv.AGEWORK_DEV_AUTH_DISABLED
    );
  });

  it("returns true when NODE_ENV is development and flag is true", () => {
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(isDevAuthDisabled()).toBe(true);
  });

  it("returns true when NODE_ENV is unset and flag is true", () => {
    delete process.env.NODE_ENV;
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(isDevAuthDisabled()).toBe(true);
  });

  it("returns false when NODE_ENV is production even if flag is true", () => {
    process.env.NODE_ENV = "production";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(isDevAuthDisabled()).toBe(false);
  });

  it("returns false when NODE_ENV is test even if flag is true", () => {
    process.env.NODE_ENV = "test";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(isDevAuthDisabled()).toBe(false);
  });

  it("returns false when flag is not true", () => {
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "false";
    expect(isDevAuthDisabled()).toBe(false);
  });

  it("returns false when flag is unset", () => {
    process.env.NODE_ENV = "development";
    delete process.env.AGEWORK_DEV_AUTH_DISABLED;
    expect(isDevAuthDisabled()).toBe(false);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
