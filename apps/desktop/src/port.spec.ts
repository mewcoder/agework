import { describe, expect, it } from "vitest";
import { pickAvailablePort } from "./port";

describe("pickAvailablePort", () => {
  it("uses a high local port for desktop backend startup", async () => {
    const port = await pickAvailablePort();

    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });
});
