import { AGENT_TYPES, type AgentType } from "@agework/shared";
import { IsIn, IsOptional, IsString } from "class-validator";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

export class ModelProviderAgentQueryDto {
  @OptionalTrimmedString()
  @IsIn([...AGENT_TYPES])
  agentType!: AgentType;

  /** 可选：工作空间绑定的 Runtime id。传入时后端会检查该 runtime 的 envConfig
   *  是否检测到对应 agent 的 CLI，未检测到则不返回「系统环境」模型配置。 */
  @IsOptional()
  @IsString()
  runtimeId?: string;
}
