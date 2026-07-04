import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

const WORKER_INSTANCE_STATUSES = [
  "running",
  "stopped",
  "error",
  "stale",
] as const;

export type WorkerInstanceStatus = (typeof WORKER_INSTANCE_STATUSES)[number];

export class AdminWorkerResourcesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @OptionalTrimmedString()
  @IsIn([...WORKER_INSTANCE_STATUSES])
  status?: WorkerInstanceStatus;
}
