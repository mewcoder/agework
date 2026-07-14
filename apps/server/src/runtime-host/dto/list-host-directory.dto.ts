import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { ListHostDirectoryRequest } from "@agework/shared/api";

export class ListHostDirectoryDto implements ListHostDirectoryRequest {
  @IsString()
  @IsNotEmpty()
  runtimeHostId!: string;

  @IsOptional()
  @IsString()
  path?: string;
}
