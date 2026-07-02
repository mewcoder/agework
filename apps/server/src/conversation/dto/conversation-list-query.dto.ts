import { IsIn, IsOptional, IsString } from "class-validator";

export class ConversationListQueryDto {
  @IsOptional()
  @IsString()
  after?: string;

  @IsOptional()
  @IsIn(["regular", "archived"])
  status?: string;

  @IsOptional()
  @IsIn(["updatedAt", "createdAt"])
  sort?: string;
}
