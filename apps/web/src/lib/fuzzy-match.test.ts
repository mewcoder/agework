import { describe, it, expect } from "vitest";
import { fuzzyMatch } from "./fuzzy-match";

describe("fuzzyMatch", () => {
  it("空 query 返回前 limit 条", () => {
    const paths = ["a.ts", "b.ts", "c.ts"];
    const result = fuzzyMatch("", paths, 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe("a.ts");
  });

  it("子序列匹配 — query 字符按序出现即命中", () => {
    const paths = ["src/auth/login.tsx", "src/utils/helpers.ts"];
    const result = fuzzyMatch("login", paths);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe("src/auth/login.tsx");
  });

  it("不匹配返回空数组", () => {
    const paths = ["src/auth/login.tsx"];
    const result = fuzzyMatch("xyz", paths);
    expect(result).toHaveLength(0);
  });

  it("连续匹配得分高于分散匹配", () => {
    const paths = ["abc-login.tsx", "a-b-c-l-o-g-i-n.tsx"];
    const result = fuzzyMatch("login", paths);
    expect(result[0]!.path).toBe("abc-login.tsx");
  });

  it("路径边界匹配加分", () => {
    // "login" at a boundary (after /) should beat "login" in the middle of a word
    const paths = ["src/login-form.tsx", "src/blogengine.tsx"];
    const result = fuzzyMatch("login", paths);
    expect(result[0]!.path).toBe("src/login-form.tsx");
  });

  it("文件名部分匹配优于目录部分", () => {
    const paths = ["login/src/app.tsx", "src/app/login.tsx"];
    const result = fuzzyMatch("login", paths);
    expect(result[0]!.path).toBe("src/app/login.tsx");
  });

  it("limit 截断", () => {
    const paths = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
    const result = fuzzyMatch("file", paths, 20);
    expect(result).toHaveLength(20);
  });

  it("大小写不敏感匹配", () => {
    const paths = ["src/App.tsx", "src/application.ts"];
    const result = fuzzyMatch("APP", paths);
    expect(result.length).toBeGreaterThan(0);
    // Both match equally (same boundary, consecutive, filename bonuses).
    // Tiebreaker: shorter path wins.
    expect(result[0]!.path).toBe("src/App.tsx");
  });

  it("邮箱不被误匹配（@ 不在 query 里，纯子序列）", () => {
    // fuzzyMatch 只做子序列匹配，不关心 @ 边界
    // 防误伤是 parser 的责任，不是 fuzzyMatch 的
    const paths = ["foo@bar.ts"];
    const result = fuzzyMatch("foo", paths);
    expect(result).toHaveLength(1);
  });

  it("等分时短路径优先", () => {
    const paths = ["src/a.ts", "src/very/deeply/nested/a.ts"];
    const result = fuzzyMatch("a", paths);
    expect(result[0]!.path).toBe("src/a.ts");
  });
});
