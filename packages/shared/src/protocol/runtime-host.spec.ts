import { describe, expect, it } from "vitest";
import {
  parseOwnerKey,
  parseWorkerKey,
  userOwnerKey,
  workerKey,
  workspaceOwnerKey,
} from "./index";

describe("owner/worker key builders", () => {
  it("builds workspace owner key", () => {
    expect(workspaceOwnerKey("ws-1")).toBe("workspace:ws-1");
  });

  it("builds user owner key", () => {
    expect(userOwnerKey("u-1")).toBe("user:u-1");
  });

  it("builds worker key with runtimeType segment", () => {
    expect(workerKey(userOwnerKey("u-1"), "docker")).toBe("user:u-1#docker");
    expect(workerKey(workspaceOwnerKey("ws-1"), "native")).toBe(
      "workspace:ws-1#native"
    );
  });

  it("parses worker key back to owner and runtimeType", () => {
    expect(parseWorkerKey(workerKey(userOwnerKey("u-1"), "docker"))).toEqual({
      owner: "user:u-1",
      runtimeType: "docker",
    });
    expect(
      parseWorkerKey(workerKey(workspaceOwnerKey("ws-1"), "native"))
    ).toEqual({ owner: "workspace:ws-1", runtimeType: "native" });
  });

  it("throws on worker key missing the runtimeType segment", () => {
    expect(() =>
      parseWorkerKey("user:u-1" as `user:${string}#${string}`)
    ).toThrow("invalid worker key");
    expect(() =>
      parseWorkerKey("user:u-1#" as `user:${string}#${string}`)
    ).toThrow("invalid worker key");
  });

  it("parses owner key back to scope and id", () => {
    expect(parseOwnerKey("workspace:ws-1")).toEqual({
      scope: "workspace",
      id: "ws-1",
    });
    expect(parseOwnerKey("user:u-1")).toEqual({ scope: "user", id: "u-1" });
  });

  it("keeps ids containing colons intact", () => {
    expect(parseOwnerKey(userOwnerKey("a:b"))).toEqual({
      scope: "user",
      id: "a:b",
    });
  });

  it("throws on malformed owner key", () => {
    expect(() => parseOwnerKey("bogus:x" as never)).toThrow(
      /invalid owner key/
    );
    expect(() => parseOwnerKey("user:" as never)).toThrow(/invalid owner key/);
  });
});
