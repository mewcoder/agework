import type { CSSProperties, ReactNode } from 'react';
import { ArrowLeft, ChevronDownIcon, type LucideIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useNativeClient } from '@/hooks/use-native-client';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

export type SettingsNavGroup<TCategory extends string> = {
  label: string;
  items: {
    id: TCategory;
    label: string;
    icon: LucideIcon;
  }[];
};

export type SettingsNavSection<TCategory extends string> = {
  label?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  hideGroupLabels?: boolean;
  groups: SettingsNavGroup<TCategory>[];
};

type SettingsPanelProps<TCategory extends string> = {
  activeCategory: TCategory;
  children: ReactNode;
  navSections: SettingsNavSection<TCategory>[];
  onCategoryChange: (category: TCategory) => void;
};

export function SettingsPageHeader({
  title,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
}) {
  const { state, isMobile } = useSidebar();
  const nativeClient = useNativeClient();
  const showTrigger = isMobile || state === 'collapsed';
  const needsNativeOffset = nativeClient && showTrigger;

  return (
    <div
      className={cn(
        'relative',
        needsNativeOffset && 'ml-[84px]',
      )}
    >
      {showTrigger ? (
        <SidebarTrigger
          className={cn(
            'absolute -left-9 top-0.5 text-muted-foreground hover:text-foreground no-drag',
          )}
        />
      ) : null}
      <h1 className="text-xl font-semibold tracking-normal">{title}</h1>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

function SettingsNavGroups<TCategory extends string>({
  activeCategory,
  groups,
  hideGroupLabels = false,
  onCategoryChange,
}: {
  activeCategory: TCategory;
  groups: SettingsNavGroup<TCategory>[];
  hideGroupLabels?: boolean;
  onCategoryChange: (category: TCategory) => void;
}) {
  return groups.map((group) => (
    <SidebarGroup key={group.label}>
      {!hideGroupLabels && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
      <SidebarMenu className="gap-0.5">
        {group.items.map((item) => {
          const Icon = item.icon;

          return (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                type="button"
                isActive={activeCategory === item.id}
                tooltip={item.label}
                onClick={() => onCategoryChange(item.id)}
                className="h-9"
              >
                <Icon />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  ));
}

function SettingsNavSectionView<TCategory extends string>({
  activeCategory,
  section,
  onCategoryChange,
}: {
  activeCategory: TCategory;
  section: SettingsNavSection<TCategory>;
  onCategoryChange: (category: TCategory) => void;
}) {
  if (!section.label) {
    return (
      <SettingsNavGroups
        activeCategory={activeCategory}
        groups={section.groups}
        hideGroupLabels={section.hideGroupLabels}
        onCategoryChange={onCategoryChange}
      />
    );
  }

  if (!section.collapsible) {
    return (
      <>
        <div className="flex items-center gap-2 px-2 py-2 group-data-[collapsible=icon]:hidden">
          <Separator className="min-w-0 flex-1 bg-sidebar-border" />
          <span className="shrink-0 text-xs font-medium text-sidebar-foreground/55">
            {section.label}
          </span>
          <Separator className="min-w-0 flex-1 bg-sidebar-border" />
        </div>
        <SettingsNavGroups
          activeCategory={activeCategory}
          groups={section.groups}
          hideGroupLabels={section.hideGroupLabels}
          onCategoryChange={onCategoryChange}
        />
      </>
    );
  }

  return (
    <Collapsible defaultOpen={section.defaultOpen ?? true}>
      <div className="px-2 py-0.5 group-data-[collapsible=icon]:hidden">
        <CollapsibleTrigger className="group/trigger inline-flex h-6 items-center gap-1 rounded-sm px-1 text-left text-[13px] font-medium text-sidebar-foreground/45 outline-hidden transition-colors hover:text-sidebar-foreground/65 focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <span>{section.label}</span>
          <ChevronDownIcon className="size-3 shrink-0 text-sidebar-foreground/45 opacity-0 transition-[opacity,transform] group-hover/trigger:opacity-100 group-focus-visible/trigger:opacity-100 group-data-closed/trigger:-rotate-90 group-data-open/trigger:rotate-0" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <SettingsNavGroups
          activeCategory={activeCategory}
          groups={section.groups}
          hideGroupLabels={section.hideGroupLabels}
          onCategoryChange={onCategoryChange}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function SettingsSidebar<TCategory extends string>({
  activeCategory,
  navSections,
  onCategoryChange,
}: Omit<SettingsPanelProps<TCategory>, 'children'>) {
  const nativeClient = useNativeClient();
  const { state, isMobile } = useSidebar();
  const showSidebarTrigger = !isMobile && state !== 'collapsed';

  return (
    <Sidebar
      variant="inset"
      collapsible="icon"
      className="[&_[data-slot=sidebar-inner]]:border-transparent [&_[data-slot=sidebar-inner]]:shadow-none"
    >
      <SidebarHeader
        className={cn(
          "h-[52px] justify-center py-0 drag-region group-data-[collapsible=icon]:px-2",
          nativeClient && state !== 'collapsed' ? "pl-[84px] pr-4" : "px-4",
        )}
      >
        <div className="flex h-full items-center justify-between">
          <SidebarMenu className="min-w-0 flex-1">
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link to="/" />}
                tooltip="返回应用"
                className="px-0 text-sidebar-foreground/70 hover:bg-transparent hover:text-sidebar-foreground no-drag"
              >
                <ArrowLeft />
                <span>返回应用</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          {showSidebarTrigger ? (
            <SidebarTrigger className="text-muted-foreground hover:text-foreground no-drag" />
          ) : null}
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navSections.map((section, index) => (
          <SettingsNavSectionView
            key={section.label ?? index}
            activeCategory={activeCategory}
            section={section}
            onCategoryChange={onCategoryChange}
          />
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

function SettingsContent({ children }: { children: ReactNode }) {
  return (
    <SidebarInset className="min-h-0 min-w-0 overflow-hidden shadow-none ring-1 ring-border/60">
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-w-0 w-full max-w-6xl flex-col px-4 py-6 md:px-6 md:py-8">
          {children}
        </div>
      </main>
    </SidebarInset>
  );
}

export function SettingsPanel<TCategory extends string>({
  activeCategory,
  children,
  navSections,
  onCategoryChange,
}: SettingsPanelProps<TCategory>) {
  return (
    <SidebarProvider
      className="h-svh overflow-hidden"
      style={{ "--sidebar-width-icon": "2.5rem" } as CSSProperties}
    >
      <SettingsSidebar
        activeCategory={activeCategory}
        navSections={navSections}
        onCategoryChange={onCategoryChange}
      />
      <SettingsContent>{children}</SettingsContent>
    </SidebarProvider>
  );
}
