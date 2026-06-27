import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import {
  normalizeUsername,
  assertPasswordForLogin,
  assertPasswordForSet,
  assertSuperAdminPasswordForSet,
  normalizeRole,
  normalizeStatus,
  generateTemporaryPassword,
} from "./user-credentials";

function expectBadRequest(fn: () => unknown, message: string) {
  expect(fn).toThrow(BadRequestException);
  expect(fn).toThrow(message);
}

describe("normalizeUsername", () => {
  it("returns a valid username trimmed", () => {
    expect(normalizeUsername("  alice  ")).toBe("alice");
  });

  it("accepts usernames with underscores and hyphens", () => {
    expect(normalizeUsername("user_name-1")).toBe("user_name-1");
  });

  it("rejects non-string input", () => {
    expectBadRequest(() => normalizeUsername(null), "用户名不能为空");
    expectBadRequest(() => normalizeUsername(undefined), "用户名不能为空");
    expectBadRequest(() => normalizeUsername(123), "用户名不能为空");
  });

  it("rejects usernames shorter than 3 characters", () => {
    expectBadRequest(() => normalizeUsername("ab"), "用户名至少需要 3 个字符");
  });

  it("rejects usernames longer than 32 characters", () => {
    expectBadRequest(
      () => normalizeUsername("a".repeat(33)),
      "用户名不能超过 32 个字符"
    );
  });

  it("rejects usernames starting with underscore", () => {
    expectBadRequest(
      () => normalizeUsername("_abc"),
      "用户名只能包含字母、数字、下划线和短横线，并以字母或数字开头"
    );
  });

  it("rejects usernames with special characters", () => {
    expectBadRequest(
      () => normalizeUsername("user@name"),
      "用户名只能包含字母、数字、下划线和短横线"
    );
  });
});

describe("assertPasswordForLogin", () => {
  it("returns the password when valid", () => {
    expect(assertPasswordForLogin("mypassword")).toBe("mypassword");
  });

  it("rejects empty string", () => {
    expectBadRequest(() => assertPasswordForLogin(""), "密码不能为空");
  });

  it("rejects non-string input", () => {
    expectBadRequest(() => assertPasswordForLogin(null), "密码不能为空");
    expectBadRequest(() => assertPasswordForLogin(undefined), "密码不能为空");
  });

  it("rejects passwords exceeding 128 characters", () => {
    expectBadRequest(
      () => assertPasswordForLogin("a".repeat(129)),
      "密码不能超过 128 个字符"
    );
  });

  it("accepts exactly 128 characters", () => {
    expect(assertPasswordForLogin("a".repeat(128))).toBe("a".repeat(128));
  });
});

describe("assertPasswordForSet", () => {
  it("returns the password when it meets all criteria", () => {
    expect(assertPasswordForSet("MyPass123")).toBe("MyPass123");
  });

  it("rejects passwords shorter than 8 characters", () => {
    expectBadRequest(
      () => assertPasswordForSet("Ab1"),
      "密码至少需要 8 个字符"
    );
  });

  it("rejects passwords with whitespace", () => {
    expectBadRequest(
      () => assertPasswordForSet("My Pass 123"),
      "密码不能包含空白字符"
    );
  });

  it("rejects passwords without letters", () => {
    expectBadRequest(
      () => assertPasswordForSet("12345678"),
      "密码需要同时包含字母和数字"
    );
  });

  it("rejects passwords without digits", () => {
    expectBadRequest(
      () => assertPasswordForSet("abcdefgh"),
      "密码需要同时包含字母和数字"
    );
  });

  it("rejects passwords that match the username (case-insensitive)", () => {
    expectBadRequest(
      () => assertPasswordForSet("Alice123", "alice123"),
      "密码不能和用户名相同"
    );
  });

  it("allows passwords that differ from the username", () => {
    expect(assertPasswordForSet("Alice456", "alice123")).toBe("Alice456");
  });
});

describe("assertSuperAdminPasswordForSet", () => {
  it("uses the provided username for comparison", () => {
    expectBadRequest(
      () => assertSuperAdminPasswordForSet("customAdmin1", "customAdmin1"),
      "密码不能和用户名相同"
    );
  });

  it("returns the password when valid", () => {
    expect(assertSuperAdminPasswordForSet("StrongPass1")).toBe("StrongPass1");
  });
});

describe("normalizeRole", () => {
  it("returns valid roles", () => {
    expect(normalizeRole("super_admin")).toBe("super_admin");
    expect(normalizeRole("admin")).toBe("admin");
    expect(normalizeRole("user")).toBe("user");
  });

  it("returns fallback for undefined", () => {
    expect(normalizeRole(undefined)).toBe("user");
  });

  it("returns custom fallback", () => {
    expect(normalizeRole(undefined, "admin")).toBe("admin");
  });

  it("rejects invalid roles", () => {
    expectBadRequest(() => normalizeRole("moderator"), "不支持的用户角色");
  });
});

describe("normalizeStatus", () => {
  it("returns valid statuses", () => {
    expect(normalizeStatus("pending")).toBe("pending");
    expect(normalizeStatus("active")).toBe("active");
    expect(normalizeStatus("disabled")).toBe("disabled");
  });

  it("rejects invalid statuses", () => {
    expectBadRequest(() => normalizeStatus("banned"), "不支持的用户状态");
  });
});

describe("generateTemporaryPassword", () => {
  it("generates a password of the default length", () => {
    const password = generateTemporaryPassword();
    expect(password).toHaveLength(18);
  });

  it("generates a password of a custom length", () => {
    const password = generateTemporaryPassword(12);
    expect(password).toHaveLength(12);
  });

  it("contains at least one letter and one digit", () => {
    const password = generateTemporaryPassword();
    expect(password).toMatch(/[A-Za-z]/);
    expect(password).toMatch(/\d/);
  });

  it("generates different passwords on successive calls", () => {
    const passwords = new Set(
      Array.from({ length: 20 }, () => generateTemporaryPassword())
    );
    expect(passwords.size).toBeGreaterThan(1);
  });
});
