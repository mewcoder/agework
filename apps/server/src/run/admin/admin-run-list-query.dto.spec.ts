import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { AdminRunListQueryDto } from "./admin-run-list-query.dto";

describe("AdminRunListQueryDto", () => {
  it("accepts supported run statuses", async () => {
    const dto = plainToInstance(AdminRunListQueryDto, {
      status: " running ",
      pageNo: "2",
      pageSize: "20",
    });

    expect(dto.status).toBe("running");
    expect(dto.pageNo).toBe(2);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects unknown run status and invalid pagination", async () => {
    const dto = plainToInstance(AdminRunListQueryDto, {
      status: "missing",
      pageNo: "0",
    });

    const properties = (await validate(dto)).map((error) => error.property);
    expect(properties).toEqual(expect.arrayContaining(["status", "pageNo"]));
  });
});
