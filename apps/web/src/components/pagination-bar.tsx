import { Button } from "@/components/ui/button";
import { getTotalPages } from "@/hooks/use-pagination";

interface PaginationBarProps {
  pageNo: number;
  pageSize: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function PaginationBar({ pageNo, pageSize, total, onPrev, onNext }: PaginationBarProps) {
  const totalPages = getTotalPages(total, pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-sm text-muted-foreground">
        第 {pageNo} / {totalPages} 页，共 {total} 条
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={pageNo <= 1}
        onClick={onPrev}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={pageNo >= totalPages}
        onClick={onNext}
      >
        下一页
      </Button>
    </div>
  );
}
