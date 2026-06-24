import {
  Allow,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Validate,
  type ValidationArguments,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import { Transform } from "class-transformer";
import { AGENT_TYPES, isAgentType, type AgentType } from "@agework/shared";
import type { AssistantUserMessage } from "../../conversation.service";

export type AgentRunForwardedProps = Record<string, unknown> & {
  agentType: AgentType;
  modelProviderId: string;
  model?: string;
};

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const fieldValue = (value as Record<string, unknown>)[key];
  return typeof fieldValue === "string" && fieldValue.trim()
    ? fieldValue.trim()
    : undefined;
}

@ValidatorConstraint({ name: "agentRunForwardedProps", async: false })
class AgentRunForwardedPropsConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    const agentType = stringField(value, "agentType");
    const modelProviderId = stringField(value, "modelProviderId");
    return isAgentType(agentType) && !!modelProviderId;
  }

  defaultMessage(args: ValidationArguments): string {
    const agentType = stringField(args.value, "agentType");
    if (agentType && !isAgentType(agentType)) {
      return `forwardedProps.agentType must be one of: ${AGENT_TYPES.join(", ")}`;
    }
    return (
      "forwardedProps.agentType and forwardedProps.modelProviderId are required"
    );
  }
}

/**
 * POST /conversations/agent/run request body.
 *
 * `forwardedProps` intentionally stays a plain object: it carries adapter-specific
 * per-run settings, so global whitelist must not strip its extra keys.
 */
export class AgentRunRequestDto {
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  threadId!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  runId?: string;

  @IsOptional()
  @IsIn(["user_steered"])
  interruptReason?: "user_steered";

  @IsOptional()
  @IsArray()
  messages?: AssistantUserMessage[];

  @IsObject()
  @Validate(AgentRunForwardedPropsConstraint)
  forwardedProps!: AgentRunForwardedProps;

  @IsOptional()
  @IsString()
  parentRunId?: string;

  @Allow()
  state?: unknown;

  @Allow()
  tools?: unknown;

  @Allow()
  context?: unknown;

  @Allow()
  resume?: unknown;
}
