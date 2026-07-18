import { useEffect } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  HandIcon,
  LockIcon,
  PencilIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useSelectionStore,
  type ClaudePermissionMode,
  type CodexPermissionMode,
  type OpenCodePermissionMode,
} from "@/stores/selection-store";
import { useAgentOptions } from "@/hooks/use-agent-options";
import { cn } from "@/lib/utils";
import type { AgentPermissionOption } from "@agework/shared/api";

const selectedMenuRadioClassName =
  "group/permission-radio min-h-12 rounded-md py-2 pl-2 pr-8 data-checked:bg-muted [&>span:first-child]:hidden";

const OPTION_ICONS: Record<string, LucideIcon> = {
  default: HandIcon,
  acceptEdits: PencilIcon,
  bypassPermissions: ShieldAlertIcon,
  plan: ShieldIcon,
  auto: ShieldCheckIcon,
  never: ShieldAlertIcon,
  "on-request": HandIcon,
  untrusted: ShieldIcon,
  "read-only": LockIcon,
  "workspace-write": PencilIcon,
  "danger-full-access": ShieldAlertIcon,
  "auto-review": ShieldCheckIcon,
  "full-access": ShieldAlertIcon,
};

/** 高权限档位(触发警示配色)。 */
const HIGH_ACCESS_MODES = new Set(["bypassPermissions", "full-access"]);

function SelectedMenuCheck() {
  return (
    <CheckIcon className="absolute right-2 size-3.5 opacity-0 transition-opacity group-data-checked/permission-radio:opacity-100" />
  );
}

function PermissionRadioItem<T extends string>({
  option,
}: {
  option: AgentPermissionOption<T>;
}) {
  const Icon = OPTION_ICONS[option.value] ?? ShieldIcon;

  return (
    <DropdownMenuRadioItem
      value={option.value}
      className={selectedMenuRadioClassName}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{option.label}</span>
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {option.description}
        </span>
      </span>
      <SelectedMenuCheck />
    </DropdownMenuRadioItem>
  );
}

export function AgentPermissionMenu() {
  const { data: agentOptions } = useAgentOptions();
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const claudePermissionMode = useSelectionStore((s) => s.claudePermissionMode);
  const codexPermissionMode = useSelectionStore((s) => s.codexPermissionMode);
  const opencodePermissionMode = useSelectionStore(
    (s) => s.opencodePermissionMode,
  );
  const setClaudePermissionMode = useSelectionStore(
    (s) => s.setClaudePermissionMode,
  );
  const setCodexPermissionMode = useSelectionStore(
    (s) => s.setCodexPermissionMode,
  );
  const setOpencodePermissionMode = useSelectionStore(
    (s) => s.setOpencodePermissionMode,
  );

  // 每个声明了 permissionMode 的 agent 一条:store 里的当前值 + setter。
  // 没在这里登记的 agent(如 pi,无权限系统)不渲染菜单。
  const selectionByAgent: Partial<
    Record<string, { value: string; set: (value: string) => void }>
  > = {
    claude: {
      value: claudePermissionMode,
      set: (v) => setClaudePermissionMode(v as ClaudePermissionMode),
    },
    codex: {
      value: codexPermissionMode,
      set: (v) => setCodexPermissionMode(v as CodexPermissionMode),
    },
    opencode: {
      value: opencodePermissionMode,
      set: (v) => setOpencodePermissionMode(v as OpenCodePermissionMode),
    },
  };

  const permissionByAgent = new Map<
    string,
    { defaultValue: string; options: ReadonlyArray<AgentPermissionOption> }
  >();
  for (const agent of agentOptions?.list ?? []) {
    const permissionMode = (
      agent.options as {
        permissionMode?: {
          defaultValue: string;
          options: ReadonlyArray<AgentPermissionOption>;
        };
      }
    ).permissionMode;
    if (permissionMode) permissionByAgent.set(agent.id, permissionMode);
  }

  // 存储值不在声明选项里(声明变更/脏数据)时回落到该 agent 的默认档。
  useEffect(() => {
    for (const [agentId, permission] of permissionByAgent) {
      const selection = selectionByAgent[agentId];
      if (!selection) continue;
      if (!permission.options.some((o) => o.value === selection.value)) {
        selection.set(permission.defaultValue);
      }
    }
  });

  const permission = permissionByAgent.get(selectedAgentType);
  const selection = selectionByAgent[selectedAgentType];
  if (!permission || !selection) return null;

  const activeOption = permission.options.find(
    (option) => option.value === selection.value,
  ) ?? {
    value: selection.value,
    label: selection.value,
    description: "操作权限",
  };
  const ActiveIcon = OPTION_ICONS[activeOption.value] ?? ShieldIcon;
  const isHighAccess = HIGH_ACCESS_MODES.has(selection.value);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={
        <button
          type="button"
          className="inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md px-2 text-xs text-foreground select-none transition-colors hover:bg-muted"
          aria-label="权限设置"
          title={activeOption.description}
        >
          <ActiveIcon
            className={cn(
              "size-3.5 shrink-0",
              isHighAccess && "text-[#c6613f]",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate",
              isHighAccess && "text-[#c6613f]",
            )}
          >
            {activeOption.label}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
        </button>
      } />
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 rounded-xl p-2 text-xs"
      >
        <DropdownMenuRadioGroup
          value={selection.value}
          onValueChange={selection.set}
        >
          <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
            操作权限
          </DropdownMenuLabel>
          {permission.options.map((option) => (
            <PermissionRadioItem key={option.value} option={option} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
