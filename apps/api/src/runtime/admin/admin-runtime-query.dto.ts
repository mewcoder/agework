import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

const RUNTIME_INSTANCE_STATUSES = [
  "running",
  "stopped",
  "error",
  "stale",
] as const;

export type RuntimeInstanceStatus = (typeof RUNTIME_INSTANCE_STATUSES)[number];

export class AdminRuntimeResourcesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @OptionalTrimmedString()
  @IsIn([...RUNTIME_INSTANCE_STATUSES])
  status?: RuntimeInstanceStatus;
}
