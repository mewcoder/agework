import type { RuntimeProviderPlugin } from "./types";

export const RUNTIME_PLUGIN_API_VERSION = 1 as const;

/**
 * 定义并校验一个 Runtime plugin。Host 仍会在装配时再次校验，避免绕过此 helper
 * 手写对象时把不兼容插件带进进程。
 */
export function defineRuntimePlugin<T extends RuntimeProviderPlugin>(
  plugin: T
): T {
  if (plugin.apiVersion !== RUNTIME_PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported runtime plugin API version: ${plugin.apiVersion}`
    );
  }
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.type)) {
    throw new Error(`Invalid runtime plugin type: ${plugin.type}`);
  }
  if (!plugin.displayName.trim()) {
    throw new Error(`Runtime plugin ${plugin.type} requires displayName`);
  }
  if (plugin.scopes.length === 0) {
    throw new Error(`Runtime plugin ${plugin.type} requires at least one scope`);
  }
  if (
    plugin.scopes.some(
      (scope) => scope !== "user" && scope !== "workspace"
    )
  ) {
    throw new Error(`Runtime plugin ${plugin.type} declares an invalid scope`);
  }
  return plugin;
}
