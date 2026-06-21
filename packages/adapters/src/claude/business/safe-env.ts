import { pickSafeEnv as pickCommonSafeEnv } from "../../common/safe-env";

export function pickSafeEnv(
  includeClaudeEnv: boolean
): Record<string, string | undefined> {
  return pickCommonSafeEnv({ includeClaudeEnv });
}
