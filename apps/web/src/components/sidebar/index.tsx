import type * as React from "react";
import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import {
  CircleUserRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  Search,
  SettingsIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ConversationList } from "./conversation-list";
import { ConversationSearchDialog } from "./conversation-search-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type Theme,
  type ThemeSkin,
  useTheme,
} from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/icon-action-button";
import { isAdmin } from "@/utils/auth";
import { useAuthStore } from "@/stores/auth-store";
import { useSelectionStore } from "@/stores/selection-store";
import { AppLogo } from "@/components/app-logo";
import { AgeWorkWordmark } from "@/components/agework-wordmark";
import { useNativeClient } from "@/hooks/use-native-client";

type ThemeOption = {
  value: Theme;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const themeOptions: ThemeOption[] = [
  { value: "light", label: "浅色", icon: SunIcon },
  { value: "dark", label: "深色", icon: MoonIcon },
  { value: "system", label: "系统", icon: MonitorIcon },
];

const skinOptions = [
  { value: "default", label: "default" },
  { value: "warm", label: "warm" },
  { value: "harbor", label: "harbor" },
  { value: "cobalt", label: "cobalt" },
] as const;

function UserFooter() {
  const { theme, skin, setTheme, setSkin } = useTheme();
  const { user, logout, authRequired } = useAuthStore();
  const settingsLabel = isAdmin(user?.role) ? "设置与管理" : "设置";
  const router = useRouter();
  function handleLogout() {
    logout();
    router.navigate({ to: "/login" });
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={
        <SidebarMenuButton className="h-10 rounded-lg px-2 hover:bg-sidebar-accent hover:shadow-sm">
          <CircleUserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-sm font-medium">
            {user?.username ?? "用户"}
          </span>
          <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
        </SidebarMenuButton>
      } />
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        alignOffset={0}
        className="w-64 rounded-xl p-2"
      >
        {user && (
          <>
            <div className="px-2 py-1.5 text-sm font-medium">{user.username}</div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup className="flex flex-col gap-2">
          <DropdownMenuItem
            render={<Link to="/settings" />}
            nativeButton={false}
            className="text-sm"
          >
            <SettingsIcon className="size-4" />
            {settingsLabel}
          </DropdownMenuItem>
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <PaletteIcon className="size-4 text-muted-foreground" />
              <span className="text-sm text-foreground">外观</span>
            </div>
            <div className="flex items-center gap-1">
              {themeOptions.map((option) => {
                const Icon = option.icon;
                const selected = theme === option.value;

                return (
                  <IconActionButton
                    key={option.value}
                    tooltip={option.label}
                    aria-pressed={selected}
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      "size-7 rounded-full hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring",
                      selected && "bg-accent text-accent-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                  </IconActionButton>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-muted-foreground" />
              <span className="text-sm text-foreground">皮肤</span>
            </div>
            <Select
              value={skin}
              onValueChange={(value) => setSkin(value as ThemeSkin)}
            >
              <SelectTrigger className="h-7 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {skinOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </DropdownMenuGroup>
        {authRequired && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="text-sm" onClick={handleLogout}>
                <LogOutIcon className="size-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkbenchSidebar({
  ...props
}: React.ComponentProps<typeof Sidebar>) {
  const { appName } = useAuthStore();
  const nativeClient = useNativeClient();
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);

  return (
    <Sidebar {...props}>
      <SidebarHeader
        className={cn(
          "justify-center py-0 select-none drag-region",
          nativeClient ? "h-10" : "h-[52px]",
          nativeClient ? "pl-[84px] pr-4" : "px-4",
        )}
      >
        <div
          data-agework-client-header
          className={cn(
            "flex h-full items-center group-data-[collapsible=icon]:hidden",
            nativeClient ? "justify-end" : "justify-between",
          )}
        >
          {!nativeClient && (
            <Link
              to="/"
              data-agework-client-brand="true"
              className="flex items-center gap-2 no-drag"
            >
              <AppLogo />
              <AgeWorkWordmark
                value={appName}
                size="md"
                tone="solid"
                className="text-sidebar-foreground"
              />
            </Link>
          )}
          <div className="flex items-center gap-1 no-drag">
            <IconActionButton
              tooltip="搜索对话"
              onClick={() => setSearchDialogOpen(true)}
              className="size-7 rounded-md hover:bg-sidebar-accent"
            >
              <Search className="size-4" />
            </IconActionButton>
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <ConversationList />
      </SidebarContent>
      <SidebarFooter className="px-2 pt-2 pb-1 select-none">
        <SidebarMenu>
          <SidebarMenuItem>
            <UserFooter />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <ConversationSearchDialog
        open={searchDialogOpen}
        onOpenChange={setSearchDialogOpen}
        activeConversationId={selectedConversationId}
      />
    </Sidebar>
  );
}
