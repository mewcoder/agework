import { describe, it, expect } from "vitest";
import { extractText } from "./message-text";

describe("extractText", () => {
  it("returns string content as-is", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("joins text parts from array", () => {
    expect(
      extractText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ])
    ).toBe("hello world");
  });

  it("filters non-text parts from array", () => {
    expect(
      extractText([
        { type: "text", text: "hello" },
        { type: "image", url: "img.png" },
        { type: "text", text: "world" },
      ])
    ).toBe("hello world");
  });

  it("recursively extracts from object with content field", () => {
    expect(
      extractText({
        id: "msg-1",
        role: "assistant",
        content: [{ type: "text", text: "nested" }],
      })
    ).toBe("nested");
  });

  it("returns empty string for null/undefined", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
  });

  it("returns empty string for objects without content", () => {
    expect(extractText({ role: "user" })).toBe("");
  });

  it("handles empty array", () => {
    expect(extractText([])).toBe("");
  });

  it("handles deeply nested content", () => {
    expect(
      extractText({
        content: {
          content: [{ type: "text", text: "deep" }],
        },
      })
    ).toBe("deep");
  });
});
