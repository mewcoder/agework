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
import {
  OptionalStringArrayQuery,
  OptionalTrimmedString,
} from "../../common/decorators/query-value.decorator";

const RAW_JSONL_CHANNELS = ["sdk.raw", "agui.event"] as const;

export class AdminRunRawEventsQueryDto {
  @OptionalTrimmedString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  runId!: string;

  @IsOptional()
  @OptionalStringArrayQuery()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(RAW_JSONL_CHANNELS, { each: true })
  channel?: ("sdk.raw" | "agui.event")[];

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
  pageSize?: number = 100;
}
