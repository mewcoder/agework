import { describe, expect, it } from "vitest";
import { WorkspaceFileCommandStore } from "./workspace-file-command.store";
import type { WorkspaceFileCommandResult } from "@agework/shared/protocol";

describe("WorkspaceFileCommandStore", () => {
  it("resolves waitForResult when resolveResult is called with matching commandId", async () => {
    const store = new WorkspaceFileCommandStore();
    const commandId = "cmd-1";

    const pending = store.waitForResult(commandId);
    const result: WorkspaceFileCommandResult = {
      type: "list_files",
      commandId,
      path: "",
      list: [],
      truncated: false,
    };

    const accepted = store.resolveResult(result);
    expect(accepted).toBe(true);
    expect(await pending).toEqual(result);
  });

  it("returns false and does not resolve when commandId does not match", async () => {
    const store = new WorkspaceFileCommandStore();
    let settled = false;
    const pending = store
      .waitForResult("cmd-1")
      .then((r) => {
        settled = true;
        return r;
      });

    const accepted = store.resolveResult({
      type: "list_files",
      commandId: "other",
      path: "",
      list: [],
      truncated: false,
    });

    expect(accepted).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // clean up
    store.cancel("cmd-1", "test cleanup");
    await expect(pending).rejects.toThrow("test cleanup");
  });

  it("returns false when there is no pending entry for the commandId", () => {
    const store = new WorkspaceFileCommandStore();
    expect(
      store.resolveResult({
        type: "read_file",
        commandId: "unknown",
        path: "",
        encoding: "utf8",
        content: "",
        size: 0,
        truncated: false,
      })
    ).toBe(false);
  });

  it("cancel rejects the pending promise", async () => {
    const store = new WorkspaceFileCommandStore();
    const pending = store.waitForResult("cmd-1");

    store.cancel("cmd-1", "timeout");
    await expect(pending).rejects.toThrow("timeout");
  });

  it("cancel is a no-op when there is no pending entry", () => {
    const store = new WorkspaceFileCommandStore();
    expect(() => store.cancel("unknown", "reason")).not.toThrow();
  });

  it("resolveResult returns false after cancel already removed the pending entry", async () => {
    const store = new WorkspaceFileCommandStore();
    const pending = store.waitForResult("cmd-1");

    store.cancel("cmd-1", "timeout");
    await expect(pending).rejects.toThrow("timeout");

    expect(
      store.resolveResult({
        type: "list_files",
        commandId: "cmd-1",
        path: "",
        list: [],
        truncated: false,
      })
    ).toBe(false);
  });

  it("rejectAll rejects all pending promises", async () => {
    const store = new WorkspaceFileCommandStore();
    const p1 = store.waitForResult("cmd-1");
    const p2 = store.waitForResult("cmd-2");

    store.rejectAll("shutdown");

    await expect(p1).rejects.toThrow("shutdown");
    await expect(p2).rejects.toThrow("shutdown");
  });

  it("handles error result shape correctly", async () => {
    const store = new WorkspaceFileCommandStore();
    const commandId = "cmd-err";
    const pending = store.waitForResult(commandId);

    const errorResult: WorkspaceFileCommandResult = {
      type: "read_file",
      commandId,
      error: "二进制文件不支持预览",
    };

    store.resolveResult(errorResult);
    const resolved = await pending;
    expect(resolved).toEqual(errorResult);
    // 调用方(workspace service)据此判断是否是错误形状
    expect("error" in resolved).toBe(true);
  });
});
