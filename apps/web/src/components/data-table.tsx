import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from "@tanstack/react-table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type DataTableColumnMeta = {
  headerClassName?: string;
  cellClassName?: string;
};

export type DataTableColumnDef<TData, TValue = unknown> = ColumnDef<TData, TValue> & {
  meta?: DataTableColumnMeta;
};

type DataTableProps<TData, TValue> = {
  columns: DataTableColumnDef<TData, TValue>[];
  data: TData[];
  emptyText: string;
  isLoading?: boolean;
  tableClassName?: string;
  wrapperClassName?: string;
  getRowId?: (originalRow: TData, index: number, parent?: Row<TData>) => string;
};

export function DataTable<TData, TValue = unknown>({
  columns,
  data,
  emptyText,
  isLoading,
  tableClassName,
  wrapperClassName,
  getRowId,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
  });

  return (
    <Table
      className={tableClassName}
      wrapperClassName={cn("overflow-auto rounded-lg border bg-card", wrapperClassName)}
    >
      <TableHeader sticky>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => {
              const meta = header.column.columnDef.meta as DataTableColumnMeta | undefined;

              return (
                <TableHead key={header.id} className={meta?.headerClassName}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              );
            })}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {isLoading || table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="py-8 text-center text-muted-foreground"
            >
              {isLoading ? "加载中…" : emptyText}
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as DataTableColumnMeta | undefined;

                return (
                  <TableCell key={cell.id} className={meta?.cellClassName}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

type DataTableTextProps = React.ComponentProps<"span"> & {
  muted?: boolean;
  mono?: boolean;
  truncate?: boolean;
};

export function DataTableText({
  className,
  muted,
  mono,
  truncate = true,
  ...props
}: DataTableTextProps) {
  return (
    <span
      className={cn(
        "block min-w-0 text-foreground",
        truncate && "truncate",
        muted && "text-muted-foreground",
        mono && "font-mono text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function DataTableEmpty({
  className,
  children = "-",
  ...props
}: React.ComponentProps<"span">) {
  return (
    <DataTableText
      muted
      className={className}
      {...props}
    >
      {children}
    </DataTableText>
  );
}

export function DataTableBadge({
  className,
  ...props
}: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      className={cn("h-5 rounded-md px-1.5 text-[11px] font-medium", className)}
      {...props}
    />
  );
}

export function DataTableActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-end gap-1", className)}
      {...props}
    />
  );
}

type DataTableButtonTone = "default" | "destructive";
type DataTableButtonProps = React.ComponentProps<typeof Button> & {
  tone?: DataTableButtonTone;
};

function tableButtonClassName(tone: DataTableButtonTone | undefined) {
  return cn(
    tone === "destructive" && "hover:text-destructive",
  );
}

export function DataTableButton({
  className,
  variant = "outline",
  size = "sm",
  tone,
  ...props
}: DataTableButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(tableButtonClassName(tone), className)}
      {...props}
    />
  );
}

export function DataTableActionButton({
  className,
  variant = "ghost",
  size = "icon-sm",
  tone,
  ...props
}: DataTableButtonProps) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(
        "text-muted-foreground",
        tableButtonClassName(tone),
        className,
      )}
      {...props}
    />
  );
}
