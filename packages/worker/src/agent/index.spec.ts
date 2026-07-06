import { beforeEach, describe, expect, it, vi } from "vitest";
import { toAgentRunInput } from "./index";

// Mock execSync before importing resolveCliPaths so the module-level
// reference is replaced.  (Vitest hoists vi.mock automatically.)
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { resolveCliPaths } from "./index";
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

    expect(resolveCliPaths({})).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });

  it("returns paths from AGEWORK_CLAUDE_CLI_PATH and AGEWORK_CODEX_CLI_PATH", () => {
    const env = {
      AGEWORK_CLAUDE_CLI_PATH: "/Resources/bin/claude",
      AGEWORK_CODEX_CLI_PATH: "/Resources/bin/codex",
    };

    expect(resolveCliPaths(env)).toEqual({
      claudeExecutablePath: "/Resources/bin/claude",
      codexExecutablePath: "/Resources/bin/codex",
    });
  });

  it("treats empty-string env vars as unset", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    expect(
      resolveCliPaths({
        AGEWORK_CLAUDE_CLI_PATH: "",
        AGEWORK_CODEX_CLI_PATH: "  ",
      })
    ).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });

  it("falls back to PATH lookup when env vars are not set", () => {
    mockedExecSync
      .mockImplementationOnce(() => "/usr/local/bin/claude\n")
      .mockImplementationOnce(() => "/usr/local/bin/codex\n");

    expect(resolveCliPaths({})).toEqual({
      claudeExecutablePath: "/usr/local/bin/claude",
      codexExecutablePath: "/usr/local/bin/codex",
    });
  });

  it("env var takes priority over PATH lookup", () => {
    // claude: env var set → findInPath("claude") not called
    // codex: env var not set → findInPath("codex") called (1st mock slot)
    mockedExecSync.mockImplementationOnce(() => "/usr/bin/codex\n");

    expect(
      resolveCliPaths({ AGEWORK_CLAUDE_CLI_PATH: "/custom/claude" })
    ).toEqual({
      claudeExecutablePath: "/custom/claude",
      codexExecutablePath: "/usr/bin/codex",
    });
  });
});
