import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { LoginDto } from "./login.dto";
import { RegisterDto } from "./register.dto";
import { SetupDto } from "./setup.dto";
import { ChangePasswordDto } from "./change-password.dto";

describe("LoginDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new LoginDto(), {
      username: "alice",
      password: "pass123",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty username", async () => {
    const dto = Object.assign(new LoginDto(), {
      username: "",
      password: "pass",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "username")).toBe(true);
  });

  it("rejects empty password", async () => {
    const dto = Object.assign(new LoginDto(), {
      username: "alice",
      password: "",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "password")).toBe(true);
  });
});

describe("RegisterDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new RegisterDto(), {
      username: "bob",
      password: "pass123",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects missing fields", async () => {
    const errors = await validate(new RegisterDto());
    expect(errors.length).toBe(2);
  });
});

describe("SetupDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new SetupDto(), { newPassword: "AdminPass1" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty newPassword", async () => {
    const dto = Object.assign(new SetupDto(), { newPassword: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "newPassword")).toBe(true);
  });
});

describe("ChangePasswordDto", () => {
  it("accepts with both fields", async () => {
    const dto = Object.assign(new ChangePasswordDto(), {
      currentPassword: "old",
      newPassword: "new",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("accepts without currentPassword (forced change)", async () => {
    const dto = Object.assign(new ChangePasswordDto(), {
      newPassword: "new",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty newPassword", async () => {
    const dto = Object.assign(new ChangePasswordDto(), { newPassword: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "newPassword")).toBe(true);
  });
});
