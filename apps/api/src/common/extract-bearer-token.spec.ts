import { describe, it, expect } from "vitest";
import { extractBearerToken } from "./extract-bearer-token";

describe("extractBearerToken", () => {
  it("extracts token from valid Bearer header", () => {
    expect(extractBearerToken({ authorization: "Bearer my-token-123" })).toBe(
      "my-token-123"
    );
  });

  it("returns null when authorization header is missing", () => {
    expect(extractBearerToken({})).toBeNull();
  });

  it("returns null when authorization header is undefined", () => {
    expect(extractBearerToken({ authorization: undefined })).toBeNull();
  });

  it("returns null when authorization header does not start with Bearer", () => {
    expect(extractBearerToken({ authorization: "Basic abc123" })).toBeNull();
  });

  it("returns null when authorization header is empty string", () => {
    expect(extractBearerToken({ authorization: "" })).toBeNull();
  });

  it("handles array authorization header by using the first element", () => {
    expect(
      extractBearerToken({
        authorization: ["Bearer first-token", "Bearer second"],
      })
    ).toBe("first-token");
  });

  it("returns null for empty array", () => {
    expect(extractBearerToken({ authorization: [] })).toBeNull();
  });

  it("returns empty string when Bearer prefix is present but token is empty", () => {
    expect(extractBearerToken({ authorization: "Bearer " })).toBe("");
  });
});
