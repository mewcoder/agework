import { describe, it, expect } from "vitest";
import "reflect-metadata";
import { RawResponse, RAW_RESPONSE_KEY } from "./raw-response.decorator";

describe("RawResponse decorator", () => {
  it("exports RAW_RESPONSE_KEY constant", () => {
    expect(RAW_RESPONSE_KEY).toBe("rawResponse");
  });

  it("sets metadata on a class", () => {
    @RawResponse()
    class TestController {}

    const metadata: unknown = Reflect.getMetadata(
      RAW_RESPONSE_KEY,
      TestController
    );
    expect(metadata).toBe(true);
  });
});
