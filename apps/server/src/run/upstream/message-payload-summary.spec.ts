import { describe, expect, it } from "vitest";
import { summarizeMessagePayload } from "./message-payload-summary";

describe("summarizeMessagePayload", () => {
  it("extracts known fields from object payload", () => {
    expect(
      summarizeMessagePayload({
        type: "run.status",
        status: "running",
        name: "test",
        pendingAction: null,
        extra: "ignored",
      })
    ).toEqual({
      type: "run.status",
      status: "running",
      name: "test",
      pendingAction: null,
    });
  });

  it("wraps non-object payload", () => {
    expect(summarizeMessagePayload("hello")).toEqual({ value: "hello" });
    expect(summarizeMessagePayload(null)).toEqual({ value: "null" });
    expect(summarizeMessagePayload(42)).toEqual({ value: "42" });
  });
});
