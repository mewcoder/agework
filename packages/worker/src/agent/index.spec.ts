import { beforeEach, describe, expect, it, vi } from "vitest";
import { toAgentRunInput } from "./index";

// Mock execSync before importing resolveAgentExecutablePath so the module-level
// reference is replaced.  (Vitest hoists vi.mock automatically.)
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { resolveAgentExecutablePath } from "./index";
import { execSync } from "node:child_process";

const mockedExecSync = vi.mocked(execSync);

describe("agent input", () => {
  it("keeps an existing AG-UI thread id", () => {
    const input = toAgentRunInput(
      { threadId: "thread-1", messages: [] },
      "conversation-1"
    );

    expect(input).toEqual({
      aguiThreadId: "thread-1",
      payload: {
        threadId: "thread-1",
        messages: [],
      },
    });
  });

  it("uses the fallback conversation id when thread id is missing", () => {
    const input = toAgentRunInput({ messages: [] }, "conversation-1");

    expect(input).toEqual({
      aguiThreadId: "conversation-1",
      payload: {
        threadId: "conversation-1",
        messages: [],
      },
    });
  });
});

describe("agent CLI paths", () => {
  beforeEach(() => {
    mockedExecSync.mockReset();
  });

  it("returns undefined when env vars are not set and CLI not in PATH", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(resolveAgentExecutablePath("claude", {})).toBeUndefined();
  });

  it("returns paths from AGEWORK_CLAUDE_CLI_PATH and AGEWORK_CODEX_CLI_PATH", () => {
    const env = {
      AGEWORK_CLAUDE_CLI_PATH: "/Resources/bin/claude",
      AGEWORK_CODEX_CLI_PATH: "/Resources/bin/codex",
    };

    expect(resolveAgentExecutablePath("claude", env)).toBe(
      "/Resources/bin/claude"
    );
    expect(resolveAgentExecutablePath("codex", env)).toBe(
      "/Resources/bin/codex"
    );
  });

  it("treats empty-string env vars as unset", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(
      resolveAgentExecutablePath("claude", {
        AGEWORK_CLAUDE_CLI_PATH: "",
      })
    ).toBeUndefined();
    expect(
      resolveAgentExecutablePath("codex", {
        AGEWORK_CODEX_CLI_PATH: "  ",
      })
    ).toBeUndefined();
  });

  it("falls back to PATH lookup when env vars are not set", () => {
    mockedExecSync.mockImplementationOnce(() => "/usr/local/bin/example\n");

    expect(resolveAgentExecutablePath("example", {})).toBe(
      "/usr/local/bin/example"
    );
  });

  it("env var takes priority over PATH lookup", () => {
    expect(
      resolveAgentExecutablePath("claude", {
        AGEWORK_CLAUDE_CLI_PATH: "/custom/claude",
      })
    ).toBe("/custom/claude");
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("derives the override env key from a plugin agent type", () => {
    expect(
      resolveAgentExecutablePath("my-agent", {
        AGEWORK_MY_AGENT_CLI_PATH: "/custom/my-agent",
      })
    ).toBe("/custom/my-agent");
  });
});
