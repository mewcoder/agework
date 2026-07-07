import { IsNotEmpty, IsString } from "class-validator";
import type { CreateRuntimeDirectoryRequest } from "@agework/shared/api";

export class CreateRuntimeDirectoryDto implements CreateRuntimeDirectoryRequest {
  @IsString()
  @IsNotEmpty()
  runtimeId!: string;

  @IsString()
  @IsNotEmpty()
  path!: string;
}
