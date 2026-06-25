import type {
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";

export type { WorkerExecutionHandle } from "@agework/shared/protocol";

export type RunWorkerExecutionStartInput = {
  runConfig: RunConfig;
  runtimeTarget: RuntimeTarget;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};
