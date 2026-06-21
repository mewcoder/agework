import { IsNotEmpty, IsString } from "class-validator";
import type { ConversationIdRequest } from "@agework/shared/api";

export class ConversationIdDto implements ConversationIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
