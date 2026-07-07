import { useNavigate, useParams } from '@tanstack/react-router';
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  Container,
  FolderIcon,
  Folders,
  ServerIcon,
  SettingsIcon,
  SlidersHorizontal,
  UsersIcon,
  UserRoundIcon,
} from 'lucide-react';
import {
  SettingsPanel,
  SettingsPageHeader,
  type SettingsNavGroup,
  type SettingsNavSection,
} from '@/components/settings/settings-panel';
import { useAuthStore } from '@/stores/auth-store';
import { UserPanel } from '@/pages/admin/user';
import { ModelProviderPanel } from '@/pages/admin/model-provider';
import { CliStatusPanel } from '@/pages/admin/cli-status';
import { RuntimePanel } from '@/pages/admin/runtime';
import { RunPanel } from '@/pages/admin/run';
import { WorkspacePanel } from '@/pages/admin/workspace';
import { WorkerPanel } from '@/pages/admin/worker';
import { SystemConfigPanel } from '@/pages/admin/system-config';
import { AccountSettings } from '@/pages/settings/account';
import { GeneralSettings } from '@/pages/settings/general';
import { ModelProvider } from '@/pages/settings/model-provider';
import { ArchivedConversations } from '@/pages/settings/archived-conversation';
import { WorkspaceSettings } from '@/pages/settings/workspace';
import { RuntimeSettings } from '@/pages/settings/runtime';
import { isAdmin as checkIsAdmin } from '@/utils/auth';

type UserCategory =
  | 'account'
  | 'general'
  | 'model'
  | 'workspaces'
  | 'runtimes'
  | 'archived';
type AdminCategory =
  | 'users'
  | 'workspaces-overview'
  | 'model-providers'
  | 'runtime-management'
  | 'workers'
  | 'runs'
  | 'system-config';
type Category = UserCategory | AdminCategory;

const USER_NAV_ITEMS: SettingsNavGroup<Category>['items'] = [
  { id: 'account', label: '账号', icon: UserRoundIcon },
  { id: 'general', label: '通用', icon: SettingsIcon },
  { id: 'model', label: '模型配置', icon: Bot },
  { id: 'workspaces', label: '工作空间', icon: FolderIcon },
  { id: 'runtimes', label: '运行环境', icon: Container },
  { id: 'archived', label: '已归档对话', icon: Archive },
];

const ADMIN_NAV_ITEMS: SettingsNavGroup<Category>['items'] = [
  { id: 'users', label: '用户管理', icon: UsersIcon },
  { id: 'workspaces-overview', label: '工作空间管理', icon: Folders },
  { id: 'model-providers', label: '模型服务管理', icon: Bot },
  { id: 'runtime-management', label: '运行环境管理', icon: Boxes },
  { id: 'workers', label: 'Worker 管理', icon: ServerIcon },
  { id: 'runs', label: '运行日志', icon: Activity },
  { id: 'system-config', label: '系统配置', icon: SlidersHorizontal },
];

const USER_NAV_GROUPS: SettingsNavGroup<Category>[] = [
  {
    label: '用户设置',
    items: USER_NAV_ITEMS,
  },
];

const ADMIN_NAV_GROUPS: SettingsNavGroup<Category>[] = [
  {
    label: '系统管理',
    items: ADMIN_NAV_ITEMS,
  },
];

const ALL_CATEGORIES = [...USER_NAV_ITEMS, ...ADMIN_NAV_ITEMS].map((i) => i.id);
const ADMIN_CATEGORY_IDS = new Set<Category>(ADMIN_NAV_ITEMS.map((i) => i.id));

function isCategory(value: string): value is Category {
  return (ALL_CATEGORIES as string[]).includes(value);
}

function isAdminCategory(id: Category): id is AdminCategory {
  return ADMIN_CATEGORY_IDS.has(id);
}

function navSections(isAdmin: boolean): SettingsNavSection<Category>[] {
  if (!isAdmin) {
    return [{ groups: USER_NAV_GROUPS, hideGroupLabels: true }];
  }

  return [
    {
      label: '用户设置',
      collapsible: true,
      defaultOpen: true,
      hideGroupLabels: true,
      groups: USER_NAV_GROUPS,
    },
    {
      label: '系统管理',
      collapsible: true,
      defaultOpen: true,
      hideGroupLabels: true,
      groups: ADMIN_NAV_GROUPS,
    },
  ];
}

export default function SettingsPage() {
  // 两条子路由（/settings/$category、/settings/admin/$category）共用这个页面，
  // 用 strict: false 读 category 参数，不管当前匹配的是哪一条
  const { category: rawCategory } = useParams({ strict: false });
  const navigate = useNavigate();
  const { user, authRequired } = useAuthStore();
  const isAdmin = checkIsAdmin(user?.role);
  // 开发免登录时无法在界面修改密码，不应锁定到账号页
  const lockedToAccount = authRequired && user?.mustChangePassword === true;

  // URL 里的 category 只是字符串，做一次校验/兜底
  const category = rawCategory && isCategory(rawCategory) ? rawCategory : 'account';
  const activeCategory = lockedToAccount ? 'account' : category;

  return (
    <SettingsPanel
      activeCategory={activeCategory}
      navSections={navSections(lockedToAccount ? false : isAdmin)}
      onCategoryChange={(next) => {
        if (lockedToAccount) return;
        if (isAdminCategory(next)) {
          navigate({ to: '/settings/admin/$category', params: { category: next } });
        } else {
          navigate({ to: '/settings/$category', params: { category: next } });
        }
      }}
    >
      {activeCategory === 'account' && <AccountSettings />}
      {activeCategory === 'general' && <GeneralSettings />}
      {activeCategory === 'model' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="模型配置"
            description="查看并切换当前可用的 Agent 模型配置"
          />
          <ModelProvider showHeader={false} />
        </div>
      )}
      {activeCategory === 'workspaces' && <WorkspaceSettings />}
      {activeCategory === 'runtimes' && <RuntimeSettings />}
      {!isAdmin && activeCategory === 'runtimes' && (
        <CliStatusPanel showHeader={false} />
      )}
      {activeCategory === 'archived' && <ArchivedConversations />}
      {isAdmin && activeCategory === 'users' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="用户管理"
            description="管理系统用户账号与权限"
          />
          <UserPanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'model-providers' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="模型服务管理"
            description="管理 Claude 和 Codex 的全局模型服务配置"
          />
          <ModelProviderPanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'runtime-management' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="运行环境管理"
            description="管理运行环境及 Agent CLI"
          />
          <RuntimePanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'workspaces-overview' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="工作空间管理"
            description="查看和管理所有用户的工作空间"
          />
          <WorkspacePanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'runs' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="运行日志"
            description="查看所有用户的 Agent 运行日志"
          />
          <RunPanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'workers' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="Worker 管理"
            description="查看和管理各用户 / 工作空间下常驻的 Worker"
          />
          <WorkerPanel showHeader={false} />
        </div>
      )}
      {isAdmin && activeCategory === 'system-config' && (
        <div className="space-y-6">
          <SettingsPageHeader
            title="系统配置"
            description="管理可在线调整的运行时配置参数"
          />
          <SystemConfigPanel showHeader={false} />
        </div>
      )}
    </SettingsPanel>
  );
}
