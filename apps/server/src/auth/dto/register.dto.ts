import { IsNotEmpty, IsString } from "class-validator";
import type { RegisterRequest } from "@agework/shared/api";

export class RegisterDto implements RegisterRequest {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
