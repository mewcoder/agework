import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { ConversationIdDto } from "./conversation-id.dto";
import { CreateConversationDto } from "./create-conversation.dto";
import { UpdateConversationDto } from "./update-conversation.dto";

describe("ConversationIdDto", () => {
  it("accepts valid id", async () => {
    const dto = Object.assign(new ConversationIdDto(), { id: "conv-1" });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new ConversationIdDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});

describe("CreateConversationDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new CreateConversationDto(), {
      workspaceId: "ws-1",
      agentType: "claude",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty workspaceId", async () => {
    const dto = Object.assign(new CreateConversationDto(), {
      workspaceId: "",
      agentType: "claude",
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "workspaceId")).toBe(true);
  });
});

describe("UpdateConversationDto", () => {
  it("accepts valid input", async () => {
    const dto = Object.assign(new UpdateConversationDto(), {
      id: "conv-1",
      title: "New Title",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects empty id", async () => {
    const dto = Object.assign(new UpdateConversationDto(), { id: "" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "id")).toBe(true);
  });
});
