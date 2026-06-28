import { IsIn, IsNotEmpty, IsString } from "class-validator";
import { AGENT_TYPES, type AgentType } from "@agework/shared";
import type {
  CreateModelProviderRequest,
  ProviderConfig,
} from "@agework/shared/api";
import { IsValidProviderConfig } from "./is-valid-provider-config.validator";

export class CreateModelProviderDto implements CreateModelProviderRequest {
  @IsString()
  @IsNotEmpty()
  @IsIn(AGENT_TYPES)
  agentType!: AgentType;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsValidProviderConfig()
  providerConfig!: ProviderConfig;
}
