import { IsNotEmpty, IsString } from "class-validator";
import type { LoginRequest } from "@agework/shared/api";

export class LoginDto implements LoginRequest {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
