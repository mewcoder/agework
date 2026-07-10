import { IsNotEmpty, IsString } from "class-validator";

export class AgentSkillsDto {
  @IsString()
  @IsNotEmpty()
  workspaceId!: string;

  @IsString()
  @IsNotEmpty()
  agentType!: string;
}
