import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { UpdateConversationRequest } from "@agework/shared/api";

const CONVERSATION_STATUSES = ["regular", "archived"] as const;

export class UpdateConversationDto implements UpdateConversationRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  @IsIn(CONVERSATION_STATUSES as unknown as string[])
  status?: string;
}
