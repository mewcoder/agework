import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { RegisterWorkerDto } from "./register-worker.dto";

describe("RegisterWorkerDto", () => {
  it("accepts a body with startToken and pid", async () => {
    const dto = plainToInstance(RegisterWorkerDto, {
      startToken: "token-1",
      pid: 4242,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it("accepts a body without pid (optional)", async () => {
    const dto = plainToInstance(RegisterWorkerDto, { startToken: "token-1" });

    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects a body missing startToken", async () => {
    const dto = plainToInstance(RegisterWorkerDto, { pid: 4242 });

    const properties = (await validate(dto)).map((error) => error.property);
    expect(properties).toContain("startToken");
  });

  it("rejects a non-integer pid", async () => {
    const dto = plainToInstance(RegisterWorkerDto, {
      startToken: "token-1",
      pid: "not-a-number",
    });

    const properties = (await validate(dto)).map((error) => error.property);
    expect(properties).toContain("pid");
  });
});
