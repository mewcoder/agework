import { describe, it, expect } from "vitest";
import { securityHeaders } from "./security-headers";

function runMiddleware(): Promise<Map<string, string>> {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (key: string, value: string) =>
      headers.set(key.toLowerCase(), value),
    removeHeader: (key: string) => headers.delete(key.toLowerCase()),
    getHeader: (key: string) => headers.get(key.toLowerCase()),
  };
  const req = { headers: {}, secure: true };

  return new Promise((resolve, reject) => {
    securityHeaders()(req as never, res as never, (err?: unknown) =>
      err
        ? reject(
            err instanceof Error
              ? err
              : new Error("security headers middleware failed")
          )
        : resolve(headers)
    );
  });
}

describe("securityHeaders", () => {
  it("sets baseline hardening headers", async () => {
    const headers = await runMiddleware();

    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("strict-transport-security")).toContain("max-age=");
    expect(headers.get("referrer-policy")).toBeTruthy();
  });

  it("leaves Content-Security-Policy unset (configured separately for SPA/SSE)", async () => {
    const headers = await runMiddleware();

    expect(headers.get("content-security-policy")).toBeUndefined();
  });
});
