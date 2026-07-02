import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { ChangePasswordRequest } from "@agework/shared/api";

export class ChangePasswordDto implements ChangePasswordRequest {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsString()
  @IsNotEmpty()
  newPassword!: string;
}
