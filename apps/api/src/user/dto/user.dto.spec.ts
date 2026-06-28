import { describe, it, expect } from "vitest";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { CreateUserDto } from "./create-user.dto";
import { UpdateUserDto } from "./update-user.dto";
import { UserIdDto } from "./user-id.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function transformBody<T extends object>(
  metatype: new () => T,
  value: object
): Promise<T> {
  return pipe.transform(value, { type: "body", metatype }) as Promise<T>;
}

describe("CreateUserDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(CreateUserDto, {
      username: "alice",
      role: "admin",
    });
    expect(result).toBeInstanceOf(CreateUserDto);
    expect(result.username).toBe("alice");
    expect(result.role).toBe("admin");
  });

  it("strips fields not declared on the DTO", async () => {
    const result = (await transformBody(CreateUserDto, {
      username: "alice",
      isAdmin: true,
    })) as CreateUserDto & { isAdmin?: boolean };
    expect(result.isAdmin).toBeUndefined();
  });

  it("rejects a payload missing the required username", async () => {
    await expect(
      transformBody(CreateUserDto, { role: "admin" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-string username", async () => {
    await expect(
      transformBody(CreateUserDto, { username: 123 })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("UpdateUserDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(UpdateUserDto, {
      id: "user-1",
      role: "user",
      status: "active",
    });
    expect(result).toBeInstanceOf(UpdateUserDto);
    expect(result.id).toBe("user-1");
  });

  it("rejects a payload missing the required id", async () => {
    await expect(
      transformBody(UpdateUserDto, { role: "user" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-string status", async () => {
    await expect(
      transformBody(UpdateUserDto, { id: "user-1", status: 123 })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("UserIdDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(UserIdDto, { id: "user-1" });
    expect(result.id).toBe("user-1");
  });

  it("rejects an empty id", async () => {
    await expect(transformBody(UserIdDto, { id: "" })).rejects.toThrow(
      BadRequestException
    );
  });

  it("rejects a missing id", async () => {
    await expect(transformBody(UserIdDto, {})).rejects.toThrow(
      BadRequestException
    );
  });
});
