import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

export const MAX_COMMAND_WAIT_MS = 30_000;

export class WorkerOwnerParamDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ownerId!: string;
}

export class WorkerCommandQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq?: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_COMMAND_WAIT_MS)
  waitMs?: number = 0;
}
