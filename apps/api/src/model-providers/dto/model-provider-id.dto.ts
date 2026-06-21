import { IsNotEmpty, IsString } from "class-validator";
import type { ModelProviderIdRequest } from "@agework/shared/api";

export class ModelProviderIdDto implements ModelProviderIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
