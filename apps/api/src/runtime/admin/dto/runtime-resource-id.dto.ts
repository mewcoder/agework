import { IsNotEmpty, IsString } from "class-validator";
import type { RuntimeResourceIdRequest } from "@agework/shared/api";

export class RuntimeResourceIdDto implements RuntimeResourceIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
