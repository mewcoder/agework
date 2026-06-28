import { normalizeBaseUrl } from "./base-url";

describe("normalizeBaseUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeBaseUrl("https://api.example.com/")).toBe(
      "https://api.example.com"
    );
  });

  it("leaves a url without trailing slash unchanged", () => {
    expect(normalizeBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com"
    );
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeBaseUrl("javascript:alert(1)")).toThrow();
  });
});
