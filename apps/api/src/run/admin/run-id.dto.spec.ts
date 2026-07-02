import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { RunIdDto } from "./run-id.dto";

describe("RunIdDto", () => {
  it("trims and requires run id", async () => {
    const dto = plainToInstance(RunIdDto, { id: " run-1 " });

    expect(dto.id).toBe("run-1");
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty run id", async () => {
    const dto = plainToInstance(RunIdDto, { id: " " });

    expect((await validate(dto)).map((error) => error.property)).toContain(
      "id"
    );
  });
});
