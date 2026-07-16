import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { API_FORMATS, type ApiFormat } from "@agework/shared";
import type {
  CreateModelProviderRequest,
  ProviderConfig,
} from "@agework/shared/api";
import { IsValidProviderConfig } from "./is-valid-provider-config.validator";

export class CreateModelProviderDto implements CreateModelProviderRequest {
  @IsString()
  @IsNotEmpty()
  @IsIn(API_FORMATS)
  apiFormat!: ApiFormat;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsValidProviderConfig()
  providerConfig!: ProviderConfig;
}
