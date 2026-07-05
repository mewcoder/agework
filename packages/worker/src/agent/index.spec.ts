import { describe, expect, it } from "vitest";
import { resolveCliPaths, toAgentRunInput } from "./index";

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
  it("returns undefined paths when env vars are not set", () => {
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
});
