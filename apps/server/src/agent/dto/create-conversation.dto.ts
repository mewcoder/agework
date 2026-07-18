import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import { AGENT_TYPES, type AgentType } from "@agework/shared";
import type { CreateConversationRequest } from "@agework/shared/api";

export class CreateConversationDto implements CreateConversationRequest {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsOptional()
  @IsString()
  firstMessage?: string;

  @IsString()
  @IsIn(AGENT_TYPES)
  agentType!: AgentType;

  @IsOptional()
  @IsString()
  title?: string;
}
