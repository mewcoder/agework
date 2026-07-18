import type {
  RuntimePluginModule,
  RuntimeProviderPlugin,
} from "@agework/runtime-sdk";
import { defineRuntimePlugin } from "@agework/runtime-sdk";

/**
 * 从部署者显式允许的包清单加载 runtime 插件。包必须导出无参 createRuntimePlugin；
 * 插件私有配置由插件自己解析，Host 不认识其 env/schema。
 */
export async function loadRuntimePlugins(
  packageNames: readonly string[]
): Promise<RuntimeProviderPlugin[]> {
  const plugins: RuntimeProviderPlugin[] = [];
  const loadedPackages = new Set<string>();

  for (const packageName of packageNames) {
    if (loadedPackages.has(packageName)) continue;
    loadedPackages.add(packageName);

    let module: RuntimePluginModule;
    try {
      module = (await import(packageName)) as RuntimePluginModule;
    } catch (error) {
      throw new Error(`Failed to load runtime plugin package: ${packageName}`, {
        cause: error,
      });
    }

    if (typeof module.createRuntimePlugin !== "function") {
      throw new Error(
        `Runtime plugin package ${packageName} must export createRuntimePlugin()`
      );
    }
    plugins.push(defineRuntimePlugin(module.createRuntimePlugin()));
  }

  return plugins;
}
