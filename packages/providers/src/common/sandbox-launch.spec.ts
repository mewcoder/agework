import { describe, it, expect } from "vitest";
import { buildSandboxStartInput } from "./sandbox-launch";
import type { RuntimeConfig, RuntimeLaunchContext } from "../types";

/**
 * 容器启动输入的共享构造点契约:worker 协议 env 拼装、挂载路径绝对性校验
 * 都只发生在这里——docker / opensandbox 两个 provider 只透传,一份测试
 * 同时代表两端。
 */

const CONFIG: RuntimeConfig = {
  workerImage: "agework/runtime:latest",
  runtimeLogHostPath: "/tmp/agework-logs/runtime",
  workerApiBaseUrl: "http://127.0.0.1:7101/api/v1",
  local: {
    workerEntryPath: "/tmp/worker/index.js",
    tsxCliPath: "/tmp/tsx/cli.mjs",
  },
};

function makeCtx(
  overrides: Partial<RuntimeLaunchContext> = {},
  placementOverrides: Record<string, unknown> = {}
): RuntimeLaunchContext {
  return {
    runtimeType: "docker",
    ownerId: "ws-1",
    workspaceId: "ws-1",
    runId: "run-1",
    placement: {
      runtimeType: "docker",
      userId: "u1",
      workspaceId: "ws-1",
      hostPath: "/tmp/workspace",
      runtimePath: "/workspace",
      runtimeLogDir: "/home/agework/.agework/logs/runtime",
      sandbox: { scope: "workspace", mountTarget: "/workspace" },
      ...placementOverrides,
    } as never,
    workerEnv: {
      AGEWORK_WORKER_OWNER_ID: "ws-1",
      AGEWORK_WORKER_ROLE: "worker",
    },
    ...overrides,
  };
}

describe("buildSandboxStartInput", () => {
  it("env = workerEnv + API_BASE/日志字段,loopback host 换成容器可达网关", () => {
    const input = buildSandboxStartInput(makeCtx(), CONFIG);
    expect(input.env.AGEWORK_WORKER_OWNER_ID).toBe("ws-1");
    expect(input.env.AGEWORK_WORKER_ROLE).toBe("worker");
    expect(input.env.AGEWORK_WORKER_API_BASE).toContain("host.docker.internal");
    expect(input.env.AGEWORK_WORKER_LOG_DIR).toBe(
      "/home/agework/.agework/logs/runtime"
    );
  });

  it("归属 metadata 由这里唯一构造", () => {
    const input = buildSandboxStartInput(makeCtx(), CONFIG);
    expect(input.metadata).toEqual({
      "agework.io/runtime-owner-id": "ws-1",
      "agework.io/scope": "workspace",
    });
  });

  it("workspace 挂载路径非绝对 → 抛错(两 provider 共享的校验)", () => {
    expect(() =>
      buildSandboxStartInput(makeCtx({}, { hostPath: "relative/path" }), CONFIG)
    ).toThrow(/absolute/);
  });

  it("日志挂载路径非绝对 → 抛错", () => {
    expect(() =>
      buildSandboxStartInput(makeCtx(), {
        ...CONFIG,
        runtimeLogHostPath: "logs/runtime",
      })
    ).toThrow(/absolute/);
  });

  it("hostPath 为空(不挂载)时不校验不抛错", () => {
    const input = buildSandboxStartInput(makeCtx({}, { hostPath: "" }), CONFIG);
    expect(input.placement.workspaceHostPath).toBe("");
  });
});
