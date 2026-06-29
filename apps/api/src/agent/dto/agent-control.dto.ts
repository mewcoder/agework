import { IsNotEmpty, IsObject, IsString } from "class-validator";
import type { SubmitQuestionAnswerRequest } from "@agework/shared/api";

export class AgentConversationIdDto {
  @IsString()
  @IsNotEmpty()
  id!: string;
}

export class AgentReplyDto
  extends AgentConversationIdDto
  implements SubmitQuestionAnswerRequest
{
  @IsObject()
  answers!: Record<string, string | string[]>;
}
