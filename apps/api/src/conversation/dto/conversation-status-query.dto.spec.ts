import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { ConversationStatusQueryDto } from "./conversation-status-query.dto";

describe("ConversationStatusQueryDto", () => {
  it("accepts valid array of ids", async () => {
    const dto = Object.assign(new ConversationStatusQueryDto(), {
      ids: ["conv-1", "conv-2"],
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects non-array ids", async () => {
    const dto = Object.assign(new ConversationStatusQueryDto(), {
      ids: "not-array",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ids")).toBe(true);
  });

  it("rejects array exceeding 50 items", async () => {
    const dto = Object.assign(new ConversationStatusQueryDto(), {
      ids: Array.from({ length: 51 }, (_, i) => `id-${i}`),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "ids")).toBe(true);
  });
});
