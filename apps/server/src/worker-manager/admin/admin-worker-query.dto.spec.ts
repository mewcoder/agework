import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { AdminWorkerResourcesQueryDto } from "./admin-worker-query.dto";

describe("AdminWorkerResourcesQueryDto", () => {
  it("accepts known runtime resource statuses", async () => {
    const dto = plainToInstance(AdminWorkerResourcesQueryDto, {
      status: " running ",
      pageNo: "1",
      pageSize: "10",
    });

    expect(dto.status).toBe("running");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects unknown runtime resource status", async () => {
    const dto = plainToInstance(AdminWorkerResourcesQueryDto, {
      status: "paused",
    });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "status"
    );
  });
});
