import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import {
  MAX_COMMAND_WAIT_MS,
  WorkerCommandQueryDto,
  WorkerOwnerParamDto,
} from "./worker-command-query.dto";

describe("WorkerOwnerParamDto", () => {
  it("trims and requires ownerId", async () => {
    const dto = plainToInstance(WorkerOwnerParamDto, { ownerId: " owner-1 " });

    expect(dto.ownerId).toBe("owner-1");
    expect(await validate(dto)).toHaveLength(0);
  });
});

describe("WorkerCommandQueryDto", () => {
  it("transforms numeric query values", async () => {
    const dto = plainToInstance(WorkerCommandQueryDto, {
      afterSeq: "12",
      waitMs: "25000",
    });

    expect(dto.afterSeq).toBe(12);
    expect(dto.waitMs).toBe(25000);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects invalid afterSeq and waitMs above the long-poll cap", async () => {
    const dto = plainToInstance(WorkerCommandQueryDto, {
      afterSeq: "abc",
      waitMs: String(MAX_COMMAND_WAIT_MS + 1),
    });

    const properties = (await validate(dto)).map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(["afterSeq", "waitMs"]));
  });
});
