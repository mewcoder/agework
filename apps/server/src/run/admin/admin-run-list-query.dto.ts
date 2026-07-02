import type { RunStatus } from "@agework/shared";
import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

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
