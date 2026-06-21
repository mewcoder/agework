import { describe, it, expect, vi, beforeEach } from "vitest";
import { copyToClipboard } from "@/utils/clipboard";

describe("copyToClipboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("优先使用 navigator.clipboard.writeText", async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextSpy },
      writable: true,
      configurable: true,
    });

    await copyToClipboard("hello");
    expect(writeTextSpy).toHaveBeenCalledWith("hello");
  });

  it("clipboard API 失败时 fallback 到 execCommand", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("not allowed")) },
      writable: true,
      configurable: true,
    });

    // jsdom 没有 execCommand，需要手动定义
    document.execCommand = vi.fn().mockReturnValue(true);

    await copyToClipboard("fallback text");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("clipboard API 和 execCommand 都失败时抛异常", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("not allowed")) },
      writable: true,
      configurable: true,
    });

    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyToClipboard("fail")).rejects.toThrow("execCommand copy failed");
  });
});
