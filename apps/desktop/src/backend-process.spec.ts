import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createBackendEnv,
  waitForBackendReady,
  type BackendHandle,
} from "./backend-process";

type FakeChildProcess = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

function makeHandle(port: number): BackendHandle {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => true);

  return {
    process: child as unknown as ChildProcess,
    port,
    stop: vi.fn(async () => {}),
  };
}

describe("waitForBackendReady", () => {
  it("fails immediately when the backend exits before becoming ready", async () => {
    const handle = makeHandle(41234);
    const child = handle.process as unknown as FakeChildProcess;

    setTimeout(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    }, 0);

    await expect(waitForBackendReady(handle, 5_000)).rejects.toThrow(
      "Backend exited before ready on port 41234"
    );
  });
});

describe("createBackendEnv", () => {
  it("does not leak Electron, Vite or Node injection environment into the backend", () => {
    const env = createBackendEnv(
      { PORT: "51234", AGEWORK_DATA_DIR: "/tmp/agework" },
      {
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
        NODE_OPTIONS: "--inspect",
        NODE_EXTRA_CA_CERTS: "/tmp/dev-ca.pem",
        UV_THREADPOOL_SIZE: "64",
        PATH: "/usr/bin",
      }
    );

    expect(env).toEqual({
      PATH: "/usr/bin",
      PORT: "51234",
      AGEWORK_DATA_DIR: "/tmp/agework",
    });
  });
});
