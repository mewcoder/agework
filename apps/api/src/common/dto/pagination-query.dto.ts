import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageNo?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 10;
}

export function pageWindow(
  query: Partial<Pick<PaginationQueryDto, "pageNo" | "pageSize">>,
  options: { defaultPageSize?: number; maxPageSize?: number } = {}
) {
  const defaultPageSize = options.defaultPageSize ?? 10;
  const maxPageSize = options.maxPageSize ?? 100;
  const pageSize = Math.min(
    Math.max(query.pageSize ?? defaultPageSize, 1),
    maxPageSize
  );
  const pageNo = Math.max(query.pageNo ?? 1, 1);
  return {
    pageNo,
    pageSize,
    take: pageSize,
    skip: (pageNo - 1) * pageSize,
  };
}
