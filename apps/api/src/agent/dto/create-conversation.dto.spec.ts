import { describe, it, expect } from "vitest";
import { ValidationPipe, BadRequestException } from "@nestjs/common";
import { CreateConversationDto } from "./create-conversation.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function transformBody<T extends object>(
  metatype: new () => T,
  value: object
): Promise<T> {
  return pipe.transform(value, { type: "body", metatype }) as Promise<T>;
}

describe("CreateConversationDto", () => {
  it("accepts a valid payload", async () => {
    const result = await transformBody(CreateConversationDto, {
      workspaceId: "proj-1",
      firstMessage: "hi",
      agentType: "claude",
    });
    expect(result).toBeInstanceOf(CreateConversationDto);
    expect(result.workspaceId).toBe("proj-1");
  });

  it("accepts a payload with only the required workspaceId", async () => {
    const result = await transformBody(CreateConversationDto, {
      workspaceId: "proj-1",
    });
    expect(result.workspaceId).toBe("proj-1");
  });

  it("rejects a payload missing the required workspaceId", async () => {
    await expect(
      transformBody(CreateConversationDto, { firstMessage: "hi" })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a non-string agentType", async () => {
    await expect(
      transformBody(CreateConversationDto, {
        workspaceId: "proj-1",
        agentType: 123,
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an unsupported agentType", async () => {
    await expect(
      transformBody(CreateConversationDto, {
        workspaceId: "proj-1",
        agentType: "unknown",
      })
    ).rejects.toThrow(BadRequestException);
  });
});
