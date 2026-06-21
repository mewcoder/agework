import { IsNotEmpty, IsString } from "class-validator";
import type { CreateModelProviderRequest, ProviderConfig } from "@agework/shared/api";
import { IsValidProviderConfig } from "./is-valid-provider-config.validator";

export class CreateModelProviderDto implements CreateModelProviderRequest {
  @IsString()
  @IsNotEmpty()
  agentType!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsValidProviderConfig()
  providerConfig!: ProviderConfig;
}
