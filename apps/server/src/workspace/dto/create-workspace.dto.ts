import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";
import type { CreateWorkspaceRequest } from "@agework/shared/api";

export class CreateWorkspaceDto implements CreateWorkspaceRequest {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  gitUrl?: string;

  @IsOptional()
  @IsString()
  gitBranch?: string;

  @IsOptional()
  @IsString()
  rootPath?: string;

  @IsOptional()
  @Matches(/^[a-z][a-z0-9-]*$/)
  runtimeType?: string;

  @IsOptional()
  @IsIn(["user", "workspace"])
  scope?: "user" | "workspace";

  @IsOptional()
  @IsString()
  runtimeHostId?: string;
}
