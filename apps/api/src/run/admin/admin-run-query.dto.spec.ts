import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import {
  AdminRunEventsQueryDto,
  AdminRunIdQueryDto,
  AdminRunListQueryDto,
} from "./admin-run-query.dto";

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

describe("AdminRunIdQueryDto", () => {
  it("trims and requires run id", async () => {
    const dto = plainToInstance(AdminRunIdQueryDto, { id: " run-1 " });

    expect(dto.id).toBe("run-1");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty run id", async () => {
    const dto = plainToInstance(AdminRunIdQueryDto, { id: " " });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "id"
    );
  });
});

describe("AdminRunEventsQueryDto", () => {
  it("normalizes comma-separated and repeated multi-select query values", async () => {
    const dto = plainToInstance(AdminRunEventsQueryDto, {
      runId: "run-1",
      type: "run.status, command.trace",
      origin: ["worker", "platform,api"],
      fromRunSeq: "1",
      toRunSeq: "5",
      pageSize: "5000",
    });

    expect(dto.type).toEqual(["run.status", "command.trace"]);
    expect(dto.origin).toEqual(["worker", "platform", "api"]);
    expect(dto.fromRunSeq).toBe(1);
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects missing runId, invalid seq, and oversized page size", async () => {
    const dto = plainToInstance(AdminRunEventsQueryDto, {
      fromRunSeq: "0",
      pageSize: "5001",
    });

    const properties = (await validate(dto)).map((error) => error.property);
    expect(properties).toEqual(
      expect.arrayContaining(["runId", "fromRunSeq", "pageSize"])
    );
  });
});
