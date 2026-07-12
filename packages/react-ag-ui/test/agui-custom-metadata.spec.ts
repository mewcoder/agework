import { describe, it, expect } from "vitest";
import type { ChatModelRunResult } from "@assistant-ui/core";
import {
  RunAggregator,
  withAgUiCustomMetadata,
  readAgUiCustomMetadata,
} from "../src/runtime/adapter/run-aggregator";
import type { AgUiEvent } from "../src/runtime/types";

/**
 * custom.agui metadata 的形状契约。嵌套结构是本包的 implementation 细节,
 * 消费方(live 聚合 / web 冷加载 / 读取组件)只允许经这两个函数出入——
 * 形状断言只活在这份测试里,别处出现即泄漏。
 */

const USAGE = { usedTokens: 1000, maxTokens: 200000, percentage: 0.5 };

describe("withAgUiCustomMetadata", () => {
  it("往空 metadata 写入,可经 read 取回(往返一致)", () => {
    const metadata = withAgUiCustomMetadata(undefined, { contextUsage: USAGE });
    expect(readAgUiCustomMetadata(metadata)?.contextUsage).toEqual(USAGE);
  });

  it("保留 metadata 其它字段、custom 其它命名空间、agui 已有字段", () => {
    const interrupts = [{ id: "q1", reason: "input_required" }];
    const base = withAgUiCustomMetadata(
      { timing: { totalStreamTime: 1 }, custom: { other: { keep: true } } },
      { interrupts },
    );
    const merged = withAgUiCustomMetadata(base, { contextUsage: USAGE });

    expect(merged.timing).toEqual({ totalStreamTime: 1 });
    expect((merged.custom as Record<string, unknown>).other).toEqual({ keep: true });
    expect(readAgUiCustomMetadata(merged)?.interrupts).toEqual(interrupts);
    expect(readAgUiCustomMetadata(merged)?.contextUsage).toEqual(USAGE);
  });

  it("空 patch 原样返回,不创建空的 custom.agui", () => {
    const base = { timing: { totalStreamTime: 1 } };
    const result = withAgUiCustomMetadata(base, {});
    expect(result).toEqual(base);
    expect(readAgUiCustomMetadata(result)).toBeUndefined();
  });

  it("值为 undefined 的字段视同缺席", () => {
    const result = withAgUiCustomMetadata({}, { contextUsage: undefined });
    expect(readAgUiCustomMetadata(result)).toBeUndefined();
  });

  it("custom 不是对象时防御性覆盖", () => {
    const result = withAgUiCustomMetadata({ custom: "broken" }, { contextUsage: USAGE });
    expect(readAgUiCustomMetadata(result)?.contextUsage).toEqual(USAGE);
  });
});

describe("readAgUiCustomMetadata", () => {
  it("缺 metadata / 缺 custom / agui 非对象 → undefined", () => {
    expect(readAgUiCustomMetadata(undefined)).toBeUndefined();
    expect(readAgUiCustomMetadata({})).toBeUndefined();
    expect(readAgUiCustomMetadata({ custom: {} })).toBeUndefined();
    expect(readAgUiCustomMetadata({ custom: { agui: "broken" } })).toBeUndefined();
  });
});

describe("RunAggregator snapshot 经同一契约出入", () => {
  it("interrupt outcome + contextUsage 可经 read 取回", () => {
    const results: ChatModelRunResult[] = [];
    const aggregator = new RunAggregator({
      showThinking: false,
      logger: { debug: () => {}, error: () => {} },
      emit: (update) => results.push(update),
    });

    aggregator.handle({ type: "RUN_STARTED", runId: "r1" } as AgUiEvent);
    aggregator.handle({
      type: "RUN_FINISHED",
      runId: "r1",
      contextUsage: USAGE,
      outcome: {
        type: "interrupt",
        interrupts: [{ id: "q1", reason: "input_required" }],
      },
    } as AgUiEvent);

    const agui = readAgUiCustomMetadata(results.at(-1)?.metadata);
    expect(agui?.contextUsage).toEqual(USAGE);
    expect(agui?.interrupts?.[0]?.id).toBe("q1");
  });
});
