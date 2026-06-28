import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { validate } from "class-validator";
import { ConversationSearchQueryDto } from "./conversation-search-query.dto";

describe("ConversationSearchQueryDto", () => {
  it("accepts valid query", async () => {
    const dto = Object.assign(new ConversationSearchQueryDto(), {
      q: "search term",
    });
    expect(await validate(dto)).toHaveLength(0);
  });

  it("rejects non-string q", async () => {
    const dto = Object.assign(new ConversationSearchQueryDto(), { q: 123 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "q")).toBe(true);
  });

  it("rejects q exceeding max length", async () => {
    const dto = Object.assign(new ConversationSearchQueryDto(), {
      q: "a".repeat(201),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "q")).toBe(true);
  });
});
