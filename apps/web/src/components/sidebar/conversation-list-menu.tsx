import {
  ArrowDownUp,
  CalendarClock,
  Check,
  Clock,
  FolderTree,
  ListFilter,
  ListTree,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconActionButton } from "@/components/icon-action-button";
import { cn } from "@/lib/utils";
import type { ConversationListViewMode, FlatSort, GroupedSort } from "@/hooks/use-conversation-list-view";

function SelectionCheck({ checked }: { checked: boolean }) {
  return (
    <Check
      className={cn(
        "ml-auto size-3.5 text-sidebar-foreground",
        !checked && "opacity-0",
      )}
    />
  );
}

interface ConversationListMenuProps {
  viewMode: ConversationListViewMode;
  onSetViewMode: (mode: ConversationListViewMode) => void;
  groupedSort: GroupedSort;
  onSetGroupedSort: (sort: GroupedSort) => void;
  flatSort: FlatSort;
  onSetFlatSort: (sort: FlatSort) => void;
}

export function ConversationListMenu({
  viewMode,
  onSetViewMode,
  groupedSort,
  onSetGroupedSort,
  flatSort,
  onSetFlatSort,
}: ConversationListMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <IconActionButton tooltip="显示选项">
          <ListFilter />
        </IconActionButton>
      } />
      <DropdownMenuContent side="bottom" align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            显示方式
          </DropdownMenuLabel>
          <DropdownMenuItem
            className="text-sm"
            onClick={() => onSetViewMode("grouped")}
          >
            <FolderTree />
            工作空间
            <SelectionCheck checked={viewMode === "grouped"} />
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-sm"
            onClick={() => onSetViewMode("flat")}
          >
            <ListTree />
            全部对话
            <SelectionCheck checked={viewMode === "flat"} />
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {viewMode === "grouped" ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              排序
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="text-sm"
              onClick={() => onSetGroupedSort("default")}
            >
              <ArrowDownUp />
              默认排序
              <SelectionCheck checked={groupedSort === "default"} />
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-sm"
              onClick={() => onSetGroupedSort("active")}
            >
              <Clock />
              按活跃时间
              <SelectionCheck checked={groupedSort === "active"} />
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              排序
            </DropdownMenuLabel>
            <DropdownMenuItem
              className="text-sm"
              onClick={() => onSetFlatSort("updatedAt")}
            >
              <Clock />
              按活跃时间
              <SelectionCheck checked={flatSort === "updatedAt"} />
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-sm"
              onClick={() => onSetFlatSort("createdAt")}
            >
              <CalendarClock />
              按创建时间
              <SelectionCheck checked={flatSort === "createdAt"} />
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
