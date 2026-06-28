import type { RunStatus } from "@agework/shared";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import {
  OptionalStringArrayQuery,
  OptionalTrimmedString,
} from "../../common/decorators/query-value.decorator";

const RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "requires_action",
  "cancelling",
  "finished",
  "error",
  "cancelled",
] as const satisfies readonly RunStatus[];

export class AdminRunListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @OptionalTrimmedString()
  @IsIn([...RUN_STATUSES])
  status?: RunStatus;
}

export class AdminRunIdQueryDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  id!: string;
}

export class AdminRunEventsQueryDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  runId!: string;

  @IsOptional()
  @OptionalStringArrayQuery()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  type?: string[];

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(200)
  typePrefix?: string;

  @IsOptional()
  @OptionalStringArrayQuery()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  origin?: string[];

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(100)
  targetType?: string;

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(100)
  targetId?: string;

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(100)
  chainId?: string;

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(100)
  refKey?: string;

  @IsOptional()
  @OptionalTrimmedString()
  @IsString()
  @MaxLength(500)
  refValue?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromRunSeq?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toRunSeq?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNo?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  pageSize?: number = 20;
}
