import { AGENT_TYPES, type AgentType } from "@agework/shared";
import { IsIn } from "class-validator";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

export class ModelProviderAgentQueryDto {
  @OptionalTrimmedString()
  @IsIn([...AGENT_TYPES])
  agentType!: AgentType;
}
