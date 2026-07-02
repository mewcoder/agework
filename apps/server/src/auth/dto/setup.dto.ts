import { IsNotEmpty, IsOptional, IsString } from "class-validator";
import type { SetupRequest } from "@agework/shared/api";

export class SetupDto implements SetupRequest {
  @IsString()
  @IsNotEmpty()
  newPassword!: string;

  @IsOptional()
  @IsString()
  adminInitKey?: string;
}
