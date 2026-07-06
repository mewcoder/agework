import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { AGENT_TYPES } from "@agework/shared";

/** admin 覆盖 runtime envConfig 的请求 body：per-agent。 */
export class UpdateEnvConfigOverrideDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsIn(AGENT_TYPES)
  agentType!: "claude" | "codex";

  /** 覆盖路径；空字符串 = 清除该 agent 的覆盖。 */
  @IsString()
  executablePath!: string;
}
