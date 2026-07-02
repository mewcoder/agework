import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { AdminRunEventsQueryDto } from "./admin-run-events-query.dto";

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
