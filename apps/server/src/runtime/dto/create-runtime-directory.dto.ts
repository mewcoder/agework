import { IsNotEmpty, IsString } from "class-validator";
import type { CreateRuntimeDirectoryRequest } from "@agework/shared/api";

export class CreateRuntimeDirectoryDto implements CreateRuntimeDirectoryRequest {
  @IsString()
  @IsNotEmpty()
  runtimeHostId!: string;

  @IsString()
  @IsNotEmpty()
  path!: string;
}
