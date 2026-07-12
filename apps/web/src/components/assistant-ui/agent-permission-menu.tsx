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
  const setClaudePermissionMode = useSelectionStore(
    (s) => s.setClaudePermissionMode,
  );
  const setCodexPermissionMode = useSelectionStore(
    (s) => s.setCodexPermissionMode,
  );

  const claudePermission = agentOptions?.list.find(
    (agent) => agent.id === "claude",
  )?.options.permissionMode;
  const codexPermission = agentOptions?.list.find(
    (agent) => agent.id === "codex",
  )?.options.permissionMode;
  const claudeOptions = claudePermission?.options ?? [];
  const codexOptions = codexPermission?.options ?? [];
  useEffect(() => {
    if (!claudePermission || !codexPermission) return;
    if (
      !claudePermission.options.some(
        (option) => option.value === claudePermissionMode,
      )
    ) {
      setClaudePermissionMode(claudePermission.defaultValue);
    }
    if (
      !codexPermission.options.some(
        (option) => option.value === codexPermissionMode,
      )
    ) {
      setCodexPermissionMode(codexPermission.defaultValue);
    }
  }, [
    claudePermissionMode,
    claudePermission,
    codexPermissionMode,
    codexPermission,
    setClaudePermissionMode,
    setCodexPermissionMode,
  ]);

  const activeClaudeOption =
    claudeOptions.find(
      (option) => option.value === claudePermissionMode,
    ) ?? {
      value: claudePermissionMode,
      label: claudePermissionMode,
      description: "操作权限",
    };
  const activeCodexOption =
    codexOptions.find((option) => option.value === codexPermissionMode) ?? {
      value: codexPermissionMode,
      label: codexPermissionMode,
      description: "操作权限",
    };
  const activeOption =
    selectedAgentType === "claude" ? activeClaudeOption : activeCodexOption;
  const ActiveIcon = OPTION_ICONS[activeOption.value] ?? ShieldIcon;
  const isHighAccess =
    (selectedAgentType === "claude" &&
      claudePermissionMode === "bypassPermissions") ||
    (selectedAgentType === "codex" && codexPermissionMode === "full-access");

  // OpenCode(及其它 ACP agent)没有可配置的权限模式,不渲染该菜单。
  if (selectedAgentType !== "claude" && selectedAgentType !== "codex") {
    return null;
  }

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
        {selectedAgentType === "claude" ? (
          <>
            <DropdownMenuRadioGroup
              value={claudePermissionMode}
              onValueChange={(value) =>
                setClaudePermissionMode(value as ClaudePermissionMode)
              }
            >
              <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
                操作权限
              </DropdownMenuLabel>
              {claudeOptions.map((option) => (
                <PermissionRadioItem key={option.value} option={option} />
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : (
          <>
            <DropdownMenuRadioGroup
              value={codexPermissionMode}
              onValueChange={(value) =>
                setCodexPermissionMode(value as CodexPermissionMode)
              }
            >
              <DropdownMenuLabel className="px-2 py-1.5 text-xs font-normal text-muted-foreground">
                操作权限
              </DropdownMenuLabel>
              {codexOptions.map((option) => (
                <PermissionRadioItem key={option.value} option={option} />
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
