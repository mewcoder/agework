import { IsNotEmpty, IsString } from "class-validator";

export class AgentConversationIdDto {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
