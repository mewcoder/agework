import { ArrayMaxSize, IsArray, IsString } from "class-validator";
import type { QueryConversationRunStatusesRequest } from "@agework/shared/api";

export class ConversationStatusQueryDto
  implements QueryConversationRunStatusesRequest
{
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids!: string[];
}
