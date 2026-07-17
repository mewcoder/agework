import type {
  RuntimeEnvConfig,
  RuntimeHostEnvConfigOverride,
} from "@agework/shared/api";
import type { RuntimeHostRow } from "../runtime-host.types";

export type ResolvedRuntimeHostCliPaths = {
  claude: string | null;
  codex: string | null;
  opencode: string | null;
  pi: string | null;
};

/** 合并 RuntimeHost 的检测结果与管理员覆盖：override > detected > null。 */
export function resolveRuntimeHostCliPaths(
  row: Pick<RuntimeHostRow, "envConfig" | "envConfigOverride">
): ResolvedRuntimeHostCliPaths {
  const detected = row.envConfig as RuntimeEnvConfig | null;
  const override = row.envConfigOverride as RuntimeHostEnvConfigOverride | null;
  return {
    claude:
      override?.claude?.executablePath ??
      detected?.claude.executablePath ??
      null,
    codex:
      override?.codex?.executablePath ?? detected?.codex.executablePath ?? null,
    opencode:
      override?.opencode?.executablePath ??
      detected?.opencode.executablePath ??
      null,
    pi: override?.pi?.executablePath ?? detected?.pi?.executablePath ?? null,
  };
}
