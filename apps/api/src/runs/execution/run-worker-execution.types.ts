import type {
  RunConfig,
  ResolvedRuntimeResource,
} from "@agework/shared/protocol";

export type { WorkerExecutionHandle } from "@agework/shared/protocol";

export type RunWorkerExecutionStartInput = {
  runConfig: RunConfig;
  runtimeResource: ResolvedRuntimeResource;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};
