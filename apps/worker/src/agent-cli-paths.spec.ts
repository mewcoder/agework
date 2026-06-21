import { describe, expect, it } from "vitest";
import { resolveAgentCliPaths } from "./agent-cli-paths.js";

describe("resolveAgentCliPaths", () => {
  it("returns undefined paths when env vars are not set", () => {
    expect(resolveAgentCliPaths({})).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });

  it("returns paths from AGEWORK_CLAUDE_CLI_PATH and AGEWORK_CODEX_CLI_PATH", () => {
    const env = {
      AGEWORK_CLAUDE_CLI_PATH: "/Resources/bin/claude",
      AGEWORK_CODEX_CLI_PATH: "/Resources/bin/codex",
    };

    expect(resolveAgentCliPaths(env)).toEqual({
      claudeExecutablePath: "/Resources/bin/claude",
      codexExecutablePath: "/Resources/bin/codex",
    });
  });

  it("treats empty-string env vars as unset", () => {
    expect(
      resolveAgentCliPaths({
        AGEWORK_CLAUDE_CLI_PATH: "",
        AGEWORK_CODEX_CLI_PATH: "  ",
      })
    ).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });
});
