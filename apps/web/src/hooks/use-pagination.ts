import { useState } from "react";

export const DEFAULT_PAGE_SIZE = 10;

// 独立导出，供调用方在拿到 total 后用 useMemo 算出展示值；
// 不放进 usePagination 的返回值，因为 pageNo 要先用于发起请求，total 是请求结果，
// 在同一次 usePagination 调用里拿不到尚未产生的 total。
export function getTotalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function usePagination(pageSize = DEFAULT_PAGE_SIZE) {
  const [pageNo, setPageNo] = useState(1);

  const goPrev = (_total: number) =>
    setPageNo((p) => Math.max(1, p - 1));

  const goNext = (total: number) =>
    setPageNo((p) => Math.min(getTotalPages(total, pageSize), p + 1));

  return {
    pageNo,
    setPageNo,
    pageSize,
    goPrev,
    goNext,
  };
}
