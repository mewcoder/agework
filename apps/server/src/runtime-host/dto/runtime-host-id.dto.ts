import { IsNotEmpty, IsString } from "class-validator";
import type { RuntimeHostIdRequest } from "@agework/shared/api";

export class RuntimeHostIdDto implements RuntimeHostIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
