import type {
  RunConfig,
  RuntimeResourceHandle,
} from "@agework/shared/protocol";

export type { WorkerExecutionHandle } from "@agework/shared/protocol";

export type RunWorkerExecutionStartInput = {
  runConfig: RunConfig;
  runtimeResource: RuntimeResourceHandle;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};
