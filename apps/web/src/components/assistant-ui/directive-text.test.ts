import { describe, it, expect } from "vitest";
import { parseDirectives } from "./directive-text";

describe("parseDirectives", () => {
  it("/ 是整条消息的第一个字符时才当 command 高亮(消息渲染场景,不传 knownCommands)", () => {
    const segments = parseDirectives("/clear the cache");
    expect(segments).toEqual([
      { kind: "mention", type: "command", label: "clear", id: "clear" },
      { kind: "text", text: " the cache" },
    ]);
  });

  it("传入 knownCommands 后,只有命中的 /word 才高亮成 command", () => {
    const segments = parseDirectives(
      "/clear now",
      undefined,
      new Set(["clear"]),
    );
    expect(segments).toEqual([
      { kind: "mention", type: "command", label: "clear", id: "clear" },
      { kind: "text", text: " now" },
    ]);
  });

  it("消息开头的绝对路径是多级 /,即使首字符是 / 也整体忽略,不只截取第一段", () => {
    const segments = parseDirectives(
      "/Users/mew/.agework",
      undefined,
      new Set(["Users", "clear", "help"]),
    );
    expect(segments).toEqual([{ kind: "text", text: "/Users/mew/.agework" }]);
  });

  it("消息中间出现的 / (前面有空格),不再当成 command 高亮 —— 只认整条消息的第一个字符", () => {
    const segments = parseDirectives(
      "see /clear",
      undefined,
      new Set(["clear"]),
    );
    expect(segments).toEqual([{ kind: "text", text: "see /clear" }]);
  });

  it("@file 提及行为不受本次改动影响:可以出现在消息中间,只要前面是空白", () => {
    const segments = parseDirectives(
      "look at @src/foo.ts please",
      new Set(["src/foo.ts"]),
    );
    expect(segments).toEqual([
      { kind: "text", text: "look at " },
      { kind: "mention", type: "file", label: "src/foo.ts", id: "src/foo.ts" },
      { kind: "text", text: " please" },
    ]);
  });
});
