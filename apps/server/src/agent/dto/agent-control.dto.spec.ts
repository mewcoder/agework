import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { AgentConversationIdDto } from "./agent-control.dto";

describe("AgentConversationIdDto", () => {
  it("accepts valid id", async () => {
    const dto = Object.assign(new AgentConversationIdDto(), { id: "conv-1" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new AgentConversationIdDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});
