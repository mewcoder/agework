import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { PaginationQueryDto, pageWindow } from "./pagination-query.dto";

describe("PaginationQueryDto", () => {
  it("transforms valid page query strings to numbers", async () => {
    const dto = plainToInstance(PaginationQueryDto, {
      pageNo: "2",
      pageSize: "25",
    });

    expect(dto.pageNo).toBe(2);
    expect(dto.pageSize).toBe(25);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("applies default pagination values", async () => {
    const dto = plainToInstance(PaginationQueryDto, {});

    expect(dto.pageNo).toBe(1);
    expect(dto.pageSize).toBe(10);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects invalid numbers and out-of-range page sizes", async () => {
    const invalidNumber = plainToInstance(PaginationQueryDto, {
      pageNo: "abc",
    });
    const tooLarge = plainToInstance(PaginationQueryDto, {
      pageSize: "101",
    });

    expect((await validate(invalidNumber)).map((e) => e.property)).toContain(
      "pageNo"
    );
    expect((await validate(tooLarge)).map((e) => e.property)).toContain(
      "pageSize"
    );
  });
});

describe("pageWindow", () => {
  it("converts page query into take and skip", () => {
    expect(pageWindow({ pageNo: 3, pageSize: 15 })).toEqual({
      pageNo: 3,
      pageSize: 15,
      take: 15,
      skip: 30,
    });
  });
});
