import type {
  RunConfig,
  RuntimeResource,
} from "@agework/shared/protocol";

export type { WorkerExecutionHandle } from "@agework/shared/protocol";

export type RunWorkerExecutionStartInput = {
  runConfig: RunConfig;
  runtimeResource: RuntimeResource;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};
