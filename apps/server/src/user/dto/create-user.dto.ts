import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { CreateUserRequest } from "@agework/shared/api";

export class CreateUserDto implements CreateUserRequest {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsOptional()
  @IsString()
  role?: string;
}
