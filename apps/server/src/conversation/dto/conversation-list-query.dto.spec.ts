import { describe, expect, it } from "vitest";
import { validate } from "class-validator";
import { ConversationListQueryDto } from "./conversation-list-query.dto";

describe("ConversationListQueryDto", () => {
  it("accepts supported filters", async () => {
    const dto = Object.assign(new ConversationListQueryDto(), {
      after: "conversation-1",
      status: "archived",
      sort: "createdAt",
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects unsupported status and sort", async () => {
    const dto = Object.assign(new ConversationListQueryDto(), {
      status: "deleted",
      sort: "title",
    });

    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining(["status", "sort"])
    );
  });
});
