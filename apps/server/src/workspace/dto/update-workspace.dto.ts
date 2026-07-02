import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { UpdateWorkspaceRequest } from "@agework/shared/api";

export class UpdateWorkspaceDto implements UpdateWorkspaceRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string | null;
}
