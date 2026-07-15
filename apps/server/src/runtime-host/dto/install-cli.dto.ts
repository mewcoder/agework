import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { AGENT_TYPES, type AgentType } from "@agework/shared";

/** admin 一键安装 Runtime Host 独立 CLI 的请求 body：per-agent。 */
export class InstallCliDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsIn(AGENT_TYPES)
  agentType!: AgentType;
}
