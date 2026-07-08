import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceFileCommandPayload,
  WorkspaceFileCommandResult,
} from "@agework/shared/protocol";

const mockBrowse = vi.fn();

vi.mock("./workspace-file-browser", () => ({
  browse: (...args: unknown[]) => mockBrowse(...args),
}));

vi.mock("../transport/worker-http", () => ({
  WorkerHttpTransport: vi.fn(),
}));

import { WorkspaceFileCommandHandler } from "./workspace-file-command.handler";

function makeTransport() {
  return {
    postFileCommandResult: vi.fn().mockResolvedValue(undefined),
  };
}

describe("WorkspaceFileCommandHandler", () => {
  it("handles list_files and posts result via transport", async () => {
    const transport = makeTransport();
    mockBrowse.mockResolvedValue({
      ok: true,
      result: {
        type: "list_files",
        commandId: "cmd-1",
        path: "",
        list: [],
        truncated: false,
      },
    });

    const handler = new WorkspaceFileCommandHandler(transport as never);

    const command: WorkspaceFileCommandPayload = {
      type: "list_files",
      commandId: "cmd-1",
      path: "",
    };

    await handler.handle(command);

    expect(transport.postFileCommandResult).toHaveBeenCalledTimes(1);
    const result = transport.postFileCommandResult.mock
      .calls[0][0] as WorkspaceFileCommandResult;
    expect(result.type).toBe("list_files");
    expect(result.commandId).toBe("cmd-1");
  });

  it("handles read_file and posts result via transport", async () => {
    const transport = makeTransport();
    mockBrowse.mockResolvedValue({
      ok: true,
      result: {
        type: "read_file",
        commandId: "cmd-2",
        path: "src/app.ts",
        encoding: "utf8",
        content: "console.log(1)",
        size: 14,
        truncated: false,
      },
    });

    const handler = new WorkspaceFileCommandHandler(transport as never);

    await handler.handle({
      type: "read_file",
      commandId: "cmd-2",
      path: "src/app.ts",
    });

    expect(transport.postFileCommandResult).toHaveBeenCalledTimes(1);
    const result = transport.postFileCommandResult.mock
      .calls[0][0] as WorkspaceFileCommandResult;
    expect(result.type).toBe("read_file");
    expect(result.commandId).toBe("cmd-2");
  });

  it("posts error result when browse returns error shape", async () => {
    const transport = makeTransport();
    mockBrowse.mockResolvedValue({
      ok: false,
      error: {
        type: "read_file",
        commandId: "cmd-err",
        error: "二进制文件不支持预览",
      },
    });

    const handler = new WorkspaceFileCommandHandler(transport as never);

    await handler.handle({
      type: "read_file",
      commandId: "cmd-err",
      path: "binary.bin",
    });

    expect(transport.postFileCommandResult).toHaveBeenCalledTimes(1);
    const result = transport.postFileCommandResult.mock
      .calls[0][0] as WorkspaceFileCommandResult;
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("二进制文件不支持预览");
    }
  });

  it("posts error result when browse throws (does not become unhandled rejection)", async () => {
    const transport = makeTransport();
    mockBrowse.mockRejectedValue(new Error("unexpected failure"));

    const handler = new WorkspaceFileCommandHandler(transport as never);

    // This should not throw - the handler catches internally
    await expect(
      handler.handle({
        type: "list_files",
        commandId: "cmd-throw",
        path: "",
      }),
    ).resolves.toBeUndefined();

    expect(transport.postFileCommandResult).toHaveBeenCalledTimes(1);
    const result = transport.postFileCommandResult.mock
      .calls[0][0] as WorkspaceFileCommandResult;
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("意外失败");
    }
  });

  it("does not throw when transport post fails", async () => {
    const transport = makeTransport();
    transport.postFileCommandResult.mockRejectedValue(
      new Error("network error"),
    );
    mockBrowse.mockResolvedValue({
      ok: true,
      result: {
        type: "list_files",
        commandId: "cmd-1",
        path: "",
        list: [],
        truncated: false,
      },
    });

    const handler = new WorkspaceFileCommandHandler(transport as never);

    // Should not throw even if transport fails
    await expect(
      handler.handle({
        type: "list_files",
        commandId: "cmd-1",
        path: "",
      }),
    ).resolves.toBeUndefined();
  });
});
