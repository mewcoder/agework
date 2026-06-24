import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AgentRunRequestDto } from "./agent-run.dto";

const pipe = new ValidationPipe({ whitelist: true, transform: true });

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "conversation-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "hi" }],
    forwardedProps: {
      agentType: "claude",
      modelProviderId: "mc-1",
      permissionMode: "acceptEdits",
    },
    ...overrides,
  };
}

function validate(body: unknown) {
  return pipe.transform(body, {
    type: "body",
    metatype: AgentRunRequestDto,
  });
}

describe("AgentRunRequestDto", () => {
  it("accepts the run body and preserves forwardedProps passthrough keys", async () => {
    const result = await validate(
      baseBody({
        state: { snapshot: true },
        tools: [{ name: "search" }],
        unexpectedTopLevel: "removed",
      })
    );

    expect(result).toBeInstanceOf(AgentRunRequestDto);
    expect(result).not.toHaveProperty("unexpectedTopLevel");
    expect(result).toMatchObject({
      state: { snapshot: true },
      tools: [{ name: "search" }],
    });
    expect(result.forwardedProps).toMatchObject({
      agentType: "claude",
      modelProviderId: "mc-1",
      permissionMode: "acceptEdits",
    });
  });

  it("requires threadId", async () => {
    await expect(validate(baseBody({ threadId: " " }))).rejects.toThrow(
      BadRequestException
    );
  });

  it("requires runId", async () => {
    await expect(validate(baseBody({ runId: undefined }))).rejects.toThrow(
      BadRequestException
    );
  });

  it("rejects blank runId", async () => {
    await expect(validate(baseBody({ runId: " " }))).rejects.toThrow(
      BadRequestException
    );
  });

  it("requires forwardedProps", async () => {
    await expect(
      validate(baseBody({ forwardedProps: undefined }))
    ).rejects.toThrow(BadRequestException);
  });

  it("requires forwardedProps.agentType", async () => {
    await expect(
      validate(baseBody({ forwardedProps: { modelProviderId: "mc-1" } }))
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects unsupported forwardedProps.agentType", async () => {
    await expect(
      validate(
        baseBody({
          forwardedProps: { agentType: "unknown", modelProviderId: "mc-1" },
        })
      )
    ).rejects.toThrow(BadRequestException);
  });

  it("requires forwardedProps.modelProviderId", async () => {
    await expect(
      validate(baseBody({ forwardedProps: { agentType: "claude" } }))
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects blank forwardedProps.modelProviderId", async () => {
    await expect(
      validate(
        baseBody({
          forwardedProps: { agentType: "claude", modelProviderId: " " },
        })
      )
    ).rejects.toThrow(BadRequestException);
  });
});
