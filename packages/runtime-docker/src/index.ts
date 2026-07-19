import {
  defineRuntimePlugin,
  type RuntimeProviderPlugin,
  type RuntimeType,
} from "@agework/runtime-sdk";
import { DockerRuntimeProvider } from "./docker-runtime.provider";
import { probeDockerDaemon } from "./probe";

export const DOCKER_RUNTIME_TYPE: "docker" = "docker" satisfies RuntimeType;

/** Official bundled Runtime Plugin and reference implementation. */
export function createRuntimePlugin(): RuntimeProviderPlugin {
  return defineRuntimePlugin({
    apiVersion: 1,
    type: DOCKER_RUNTIME_TYPE,
    displayName: "Docker",
    scopes: ["user", "workspace"],
    probe: probeDockerDaemon,
    create: (config) => new DockerRuntimeProvider(config),
  });
}
