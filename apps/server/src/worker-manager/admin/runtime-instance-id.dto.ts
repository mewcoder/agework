import { IsNotEmpty, IsString } from "class-validator";
import type { RuntimeInstanceIdRequest } from "@agework/shared/api";

export class RuntimeInstanceIdDto implements RuntimeInstanceIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
