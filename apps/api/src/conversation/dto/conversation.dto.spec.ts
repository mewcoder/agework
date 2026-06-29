import { describe, it, expect } from "vitest";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { UpdateConversationDto } from "./update-conversation.dto";
import { ConversationIdDto } from "./conversation-id.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function transformBody<T extends object>(
  metatype: new () => T,
  value: object
): Promise<T> {
  return pipe.transform(value, { type: "body", metatype }) as Promise<T>;
}

describe("UpdateConversationDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(UpdateConversationDto, {
      id: "conversation-1",
      title: "New title",
      status: "archived",
    });
    expect(result.id).toBe("conversation-1");
    expect(result.title).toBe("New title");
  });

  it("rejects a payload missing the required id", async () => {
    await expect(
      transformBody(UpdateConversationDto, { title: "New title" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-string title", async () => {
    await expect(
      transformBody(UpdateConversationDto, { id: "conversation-1", title: 123 })
    ).rejects.toThrow(BadRequestException);
  });
});

describe("ConversationIdDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(ConversationIdDto, {
      id: "conversation-1",
    });
    expect(result.id).toBe("conversation-1");
  });

  it("rejects a missing id", async () => {
    await expect(transformBody(ConversationIdDto, {})).rejects.toThrow(
      BadRequestException
    );
  });
});
