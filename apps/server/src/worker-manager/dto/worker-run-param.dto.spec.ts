import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { WorkerRunParamDto } from "./worker-run-param.dto";

describe("WorkerRunParamDto", () => {
  it("trims and requires runId", async () => {
    const dto = plainToInstance(WorkerRunParamDto, { runId: " run-1 " });

    expect(dto.runId).toBe("run-1");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty runId", async () => {
    const dto = plainToInstance(WorkerRunParamDto, { runId: " " });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "runId"
    );
  });
});
