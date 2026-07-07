import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { ListRuntimeDirectoryRequest } from "@agework/shared/api";

export class ListRuntimeDirectoryDto implements ListRuntimeDirectoryRequest {
  @IsString()
  @IsNotEmpty()
  runtimeId!: string;

  @IsOptional()
  @IsString()
  path?: string;
}
