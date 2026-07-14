import { IsIn, IsNotEmpty, IsOptional, IsString } from "class-validator";
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
  @IsIn(["native", "docker", "opensandbox"])
  runtimeType?: "native" | "docker" | "opensandbox";

  @IsOptional()
  @IsIn(["user", "workspace"])
  scope?: "user" | "workspace";

  @IsOptional()
  @IsString()
  runtimeId?: string;
}
