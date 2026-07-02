import { Logger } from "@nestjs/common";
import { swallow } from "./swallow";

describe("swallow", () => {
  it("logs the label and error message at debug level for Error instances", () => {
    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;

    swallow(logger, "persist message")(new Error("db down"));

    expect(debug).toHaveBeenCalledWith("persist message: db down");
  });

  it("logs the label and stringified value for non-Error rejections", () => {
    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;

    swallow(logger, "persist message")("boom");

    expect(debug).toHaveBeenCalledWith("persist message: boom");
  });

  it("can be used directly as a Promise.catch handler without throwing", async () => {
    const debug = vi.fn();
    const logger = { debug } as unknown as Logger;

    await Promise.reject(new Error("fail")).catch(swallow(logger, "label"));

    expect(debug).toHaveBeenCalledWith("label: fail");
  });
});
