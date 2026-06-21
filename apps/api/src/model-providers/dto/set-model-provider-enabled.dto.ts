import { IsBoolean, IsNotEmpty, IsString } from "class-validator";
import type { SetModelProviderEnabledRequest } from "@agework/shared/api";

export class SetModelProviderEnabledDto implements SetModelProviderEnabledRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsBoolean()
  isEnabled!: boolean;
}
