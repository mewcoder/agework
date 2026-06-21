import { IsNotEmpty, IsString } from "class-validator";
import type { UserIdRequest } from "@agework/shared/api";

export class UserIdDto implements UserIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
