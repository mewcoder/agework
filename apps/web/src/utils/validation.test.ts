import { describe, it, expect } from "vitest";
import { usernameSchema, passwordSchema, validationMessage } from "./validation";

describe("usernameSchema", () => {
  it("接受合法用户名", () => {
    expect(usernameSchema.safeParse("alice").success).toBe(true);
    expect(usernameSchema.safeParse("bob_123").success).toBe(true);
    expect(usernameSchema.safeParse("A-B_C").success).toBe(true);
  });

  it("拒绝太短的用户名", () => {
    const r = usernameSchema.safeParse("ab");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("3");
  });

  it("拒绝以特殊字符开头的用户名", () => {
    const r = usernameSchema.safeParse("_alice");
    expect(r.success).toBe(false);
  });

  it("拒绝包含非法字符的用户名", () => {
    const r = usernameSchema.safeParse("alice@example");
    expect(r.success).toBe(false);
  });
});

describe("passwordSchema", () => {
  it("接受合法密码", () => {
    expect(passwordSchema.safeParse("abc12345").success).toBe(true);
    expect(passwordSchema.safeParse("MyP@ssw0rd!").success).toBe(true);
  });

  it("拒绝太短的密码", () => {
    const r = passwordSchema.safeParse("ab12");
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain("8");
  });

  it("拒绝只有字母的密码", () => {
    const r = passwordSchema.safeParse("abcdefgh");
    expect(r.success).toBe(false);
  });

  it("拒绝只有数字的密码", () => {
    const r = passwordSchema.safeParse("12345678");
    expect(r.success).toBe(false);
  });

  it("拒绝包含空白的密码", () => {
    const r = passwordSchema.safeParse("abc 1234");
    expect(r.success).toBe(false);
  });
});

describe("validationMessage", () => {
  it("合法输入返回空字符串", () => {
    expect(validationMessage(usernameSchema, "alice")).toBe("");
  });

  it("非法输入返回第一条错误消息", () => {
    const msg = validationMessage(usernameSchema, "ab");
    expect(msg).toBeTruthy();
    expect(msg).toContain("3");
  });
});
