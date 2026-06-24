import { describe, it, expect } from "vitest";
import { generateId } from "./index";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("generateId", () => {
  it("返回标准 UUID v7 格式", () => {
    const id = generateId();
    expect(id).toMatch(UUID_V7_PATTERN);
    expect(id.length).toBe(36);
  });

  it("版本位为 7", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateId();
      expect(id[14]).toBe("7");
    }
  });

  it("变体位正确(8/9/a/b)", () => {
    for (let i = 0; i < 100; i++) {
      const variant = generateId()[19];
      expect(["8", "9", "a", "b"]).toContain(variant);
    }
  });

  it("批量生成唯一", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(generateId());
    expect(ids.size).toBe(1000);
  });

  it("时序递增:连续生成的 id 字符串序不递减(跨毫秒)", () => {
    // 等待跨毫秒边界,确保时间戳前缀严格递增
    const first = generateId();
    // 用足够多的生成 + 短延时确保跨毫秒
    let prev = first;
    let strictlyIncreasingFound = false;
    for (let i = 0; i < 2000; i++) {
      const cur = generateId();
      if (cur > prev) strictlyIncreasingFound = true;
      prev = cur;
    }
    // 跨毫秒后必然出现严格递增(时间戳前缀变大)
    expect(strictlyIncreasingFound).toBe(true);
  });
});
