import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { UpdateUserRequest } from "@agework/shared/api";

export class UpdateUserDto implements UpdateUserRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  status?: string;
}
