import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { CreateConversationRequest } from "@agework/shared/api";

export class CreateConversationDto implements CreateConversationRequest {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsOptional()
  @IsString()
  firstMessage?: string;

  @IsOptional()
  @IsString()
  agentType?: string;

  @IsOptional()
  @IsString()
  title?: string;
}
