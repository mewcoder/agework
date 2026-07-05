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
  rootPath?: string;

  @IsOptional()
  @IsIn(["local", "docker", "opensandbox"])
  runtimeType?: "local" | "docker" | "opensandbox";

  @IsOptional()
  @IsIn(["user", "workspace"])
  isolationScope?: "user" | "workspace";

  @IsOptional()
  @IsString()
  runtimeId?: string;
}
