import type {
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";

export type { WorkerExecutionHandle } from "@agework/shared/protocol";

export type RunDriverStartInput = {
  runConfig: RunConfig;
  runtimeTarget: RuntimeTarget;
  onRuntimeInstanceIdReady?: (runtimeInstanceId: string) => void;
};
