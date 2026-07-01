import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { AdminRuntimeResourcesQueryDto } from "./admin-runtime-query.dto";

describe("AdminRuntimeResourcesQueryDto", () => {
  it("accepts known runtime resource statuses", async () => {
    const dto = plainToInstance(AdminRuntimeResourcesQueryDto, {
      status: " running ",
      pageNo: "1",
      pageSize: "10",
    });

    expect(dto.status).toBe("running");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects unknown runtime resource status", async () => {
    const dto = plainToInstance(AdminRuntimeResourcesQueryDto, {
      status: "paused",
    });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "status"
    );
  });
});
