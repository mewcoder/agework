import { IsNotEmpty, IsString } from "class-validator";
import type { RuntimeIdRequest } from "@agework/shared/api";

export class RuntimeIdDto implements RuntimeIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
