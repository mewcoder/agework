import { IsNotEmpty, IsString } from "class-validator";
import type { UpdateModelProviderRequest, ProviderConfig } from "@agework/shared/api";
import { IsValidProviderConfig } from "./is-valid-provider-config.validator";

export class UpdateModelProviderDto implements UpdateModelProviderRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsValidProviderConfig()
  providerConfig!: ProviderConfig;
}
