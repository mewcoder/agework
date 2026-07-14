import { IsNotEmpty, IsString } from "class-validator";
import type { CreateHostDirectoryRequest } from "@agework/shared/api";

export class CreateHostDirectoryDto implements CreateHostDirectoryRequest {
  @IsString()
  @IsNotEmpty()
  runtimeHostId!: string;

  @IsString()
  @IsNotEmpty()
  path!: string;
}
