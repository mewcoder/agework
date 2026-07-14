import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import type { CreateRuntimeHostRequest } from "@agework/shared/api";

export class CreateRuntimeHostDto implements CreateRuntimeHostRequest {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name!: string;
}
