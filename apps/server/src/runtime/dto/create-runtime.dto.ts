import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import type { CreateRuntimeRequest } from "@agework/shared/api";

export class CreateRuntimeDto implements CreateRuntimeRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name!: string;
}
