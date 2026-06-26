import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { UserIdDto } from "./user-id.dto";
import { CreateUserDto } from "./create-user.dto";
import { UpdateUserDto } from "./update-user.dto";

describe("UserIdDto", () => {
  it("accepts valid id", async () => {
    const dto = Object.assign(new UserIdDto(), { id: "user-123" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new UserIdDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});

describe("CreateUserDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new CreateUserDto(), {
      username: "alice",
      role: "user",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("accepts without optional role", async () => {
    const dto = Object.assign(new CreateUserDto(), { username: "alice" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty username", async () => {
    const dto = Object.assign(new CreateUserDto(), { username: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "username")).toBe(true);
  });
});

describe("UpdateUserDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new UpdateUserDto(), {
      id: "user-1",
      role: "admin",
      status: "active",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new UpdateUserDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});
