import { describe, it, expect, vi, afterEach } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync };
});

import { getVersion } from "./cli-resolver";

function versionResult(stdout: string, status = 0) {
  return { error: undefined, status, stdout };
}

/** 测试内临时伪装平台(getVersion 按 process.platform 分派)。 */
function stubPlatform(platform: NodeJS.Platform): () => void {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform });
  return () => Object.defineProperty(process, "platform", { value: original });
}

afterEach(() => {
  spawnSync.mockReset();
});

describe("getVersion(执行方式按路径形态分派)", () => {
  it("Unix 二进制直接 spawn,不带 shell", () => {
    const restore = stubPlatform("linux");
    try {
      spawnSync.mockReturnValue(versionResult("2.1.201 (Claude Code)"));

      expect(getVersion("/usr/local/bin/claude")).toBe("2.1.201");

      const [command, args, options] = spawnSync.mock.calls[0];
      expect(command).toBe("/usr/local/bin/claude");
      expect(args).toEqual(["--version"]);
      expect(options).not.toHaveProperty("shell");
    } finally {
      restore();
    }
  });

  it("Windows .exe(含空格路径)直接 spawn,不经 shell 拆分", () => {
    const restore = stubPlatform("win32");
    try {
      spawnSync.mockReturnValue(versionResult("2.1.201 (Claude Code)"));

      expect(getVersion("C:/Program Files/Claude/claude.exe")).toBe("2.1.201");

      const [command, , options] = spawnSync.mock.calls[0];
      expect(command).toBe("C:/Program Files/Claude/claude.exe");
      expect(options).not.toHaveProperty("shell");
    } finally {
      restore();
    }
  });

  it("Windows npm shim (.cmd) 经 cmd /c basename + dirname 进 PATH", () => {
    const restore = stubPlatform("win32");
    try {
      spawnSync.mockReturnValue(versionResult("codex-cli 0.142.2"));

      expect(getVersion("C:/Users/mew/AppData/Roaming/npm/codex.cmd")).toBe(
        "0.142.2"
      );

      const [command, args, options] = spawnSync.mock.calls[0] as [
        string,
        string[],
        { env: { PATH: string } },
      ];
      expect(command).toBe("cmd");
      expect(args).toEqual(["/c", "codex.cmd", "--version"]);
      expect(options.env.PATH.startsWith("C:/Users/mew/AppData/Roaming/npm;")).toBe(
        true
      );
    } finally {
      restore();
    }
  });

  it("JS 入口(cli.js)用 node 执行而不是直接 spawn", () => {
    const restore = stubPlatform("win32");
    try {
      spawnSync.mockReturnValue(versionResult("2.1.201 (Claude Code)"));
      const cliJs =
        "C:/Users/mew/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js";

      expect(getVersion(cliJs)).toBe("2.1.201");

      const [command, args] = spawnSync.mock.calls[0];
      expect(command).toBe(process.execPath);
      expect(args).toEqual([cliJs, "--version"]);
    } finally {
      restore();
    }
  });

  it("非零退出码 / 空输出返回 null", () => {
    spawnSync.mockReturnValueOnce(versionResult("boom", 1));
    expect(getVersion("/usr/local/bin/claude")).toBeNull();

    spawnSync.mockReturnValueOnce(versionResult(""));
    expect(getVersion("/usr/local/bin/claude")).toBeNull();
  });
});
