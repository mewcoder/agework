import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { RuntimeInstanceIdDto } from "./runtime-instance-id.dto";

describe("RuntimeInstanceIdDto", () => {
  it("accepts valid id", async () => {
    const dto = Object.assign(new RuntimeInstanceIdDto(), { id: "ri-1" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new RuntimeInstanceIdDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });

  it("rejects non-string id", async () => {
    const dto = Object.assign(new RuntimeInstanceIdDto(), { id: 123 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});
