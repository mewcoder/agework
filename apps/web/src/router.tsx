import { Suspense, lazy } from "react";
import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppToaster } from "@/components/app-toaster";
import { ErrorBoundary } from "@/components/error-boundary";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthStore } from "@/stores/auth-store";
import { authApi } from "@/api/auth";
import { conversationsApi } from "@/api/conversations";
import { queryClient } from "@/lib/query-client";
import { conversationKeys } from "@/lib/conversations-cache";
import { normalizeBasePath } from "@/utils/path";
import WorkbenchPage, { WorkbenchRuntimeLayout } from "@/pages/workbench";
import type { Conversation } from "@/api/conversations";
import type { AuthConfigResponse } from "@agework/shared/api";

function applyAuthConfig(config: AuthConfigResponse) {
  const store = useAuthStore.getState();
  store.setAuthRequired(config.authRequired);
  store.setSetupRequired(config.setupRequired);
  store.setAppName(config.appName);
  store.setConfigLoaded(true);
  document.title = config.appName;

  if (config.setupRequired) {
    store.logout();
    queryClient.removeQueries({ queryKey: ["auth", "me"] });
  }
}

async function hydrateSession(config: AuthConfigResponse) {
  // 开发免登录：后端始终以真实 admin 响应，刷新本地用户缓存避免与后端状态不一致
  if (!config.authRequired) {
    const user = await queryClient.fetchQuery({
      queryKey: ["auth", "me"],
      queryFn: () => authApi.me(),
      staleTime: 5 * 60 * 1000,
    });
    useAuthStore.getState().setAuth(null, user);
    return;
  }
  // 需要登录：access token 只在内存，刷新页面后用 refresh cookie 静默换取新的 access token
  if (config.setupRequired || useAuthStore.getState().token) return;
  try {
    const { token, user } = await authApi.refresh();
    useAuthStore.getState().setAuth(token, user);
  } catch {
    // 无有效 refresh cookie → 保持未登录，路由守卫会跳 /login
  }
}

const rootRoute = createRootRoute({
  beforeLoad: async () => {
    // 每次 app 启动时从服务端读取认证配置（通过 queryClient 缓存，避免路由切换时重复请求）
    try {
      const config = await queryClient.fetchQuery({
        queryKey: ["auth", "config"],
        queryFn: () => authApi.config(),
        staleTime: 5 * 60 * 1000, // 5 分钟内复用缓存
      });
      applyAuthConfig(config);
      await hydrateSession(config);
    } catch (e) {
      // API 未就绪时轮询等待，避免 authRequired 保持默认 true 导致立即跳转 /login
      console.warn("[router] auth config unavailable, retrying...", e);
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const config = await queryClient.fetchQuery({
            queryKey: ["auth", "config"],
            queryFn: () => authApi.config(),
            staleTime: 0, // 重试时强制刷新
          });
          applyAuthConfig(config);
          await hydrateSession(config);
          return;
        } catch {
          // 继续重试
        }
      }
    }
  },
  component: () => (
    <ThemeProvider>
      <TooltipProvider delay={0}>
        <ErrorBoundary>
          <Suspense fallback={<div className="flex h-screen items-center justify-center"><div className="size-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" /></div>}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
        <AppToaster />
      </TooltipProvider>
    </ThemeProvider>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: lazy(() => import("@/pages/login")),
});

// 认证后可访问的布局层
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  beforeLoad: () => {
    const { token, authRequired, setupRequired, user, configLoaded } = useAuthStore.getState();
    // config 未加载时（server 还没启动），不做路由判断，避免误跳 /login
    if (!configLoaded) return;
    if (authRequired && setupRequired) throw redirect({ to: "/login" });
    if (authRequired && !token) throw redirect({ to: "/login" });
    if (authRequired && user?.mustChangePassword) {
      throw redirect({ to: "/login" });
    }
  },
  component: Outlet,
});

// pathless layout：让 AgentChatRuntimeProvider 跨 / ↔ /c/$conversationId 持久挂载（后台会话保活）
const workbenchRuntimeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  id: "workbench",
  component: WorkbenchRuntimeLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => workbenchRuntimeRoute,
  path: "/",
  component: WorkbenchPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings",
  component: Outlet,
});

// 裸 /settings 自动重定向到默认子页 /settings/account
// 用 index route 承接，避免把无条件 redirect 写在父路由 beforeLoad 里导致命中
// /settings/$category 时父路由 beforeLoad 仍执行而陷入无限重定向。
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$category", params: { category: "account" } });
  },
});

const settingsCategoryRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/$category",
  beforeLoad: ({ params }) => {
    // 保留原来"改密码前锁死在账号页"的行为：从组件里挪到路由层
    const { authRequired, user } = useAuthStore.getState();
    const lockedToAccount = authRequired && user?.mustChangePassword === true;
    // 注意：这个分支目前理论上很难触发，因为 authenticatedRoute 的 beforeLoad
    // 已经在 mustChangePassword 为 true 时把人重定向去 /login 了；保留只是为了
    // 不丢失原有防御性行为（比如登录后 session 状态才变化的时间差）。
    if (lockedToAccount && params.category !== "account") {
      throw redirect({ to: "/settings/$category", params: { category: "account" } });
    }
  },
  component: lazy(() => import("@/pages/settings")),
});

// 系统管理分类单独挂在 /settings/admin/ 前缀下，和后端 /api/v1/admin/... 的约定保持一致，
// URL 上就能区分"个人设置"和"系统管理"，不用靠 category 字符串本身避免撞名。
const settingsAdminCategoryRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/admin/$category",
  beforeLoad: () => {
    const { authRequired, user } = useAuthStore.getState();
    const lockedToAccount = authRequired && user?.mustChangePassword === true;
    if (lockedToAccount) {
      throw redirect({ to: "/settings/$category", params: { category: "account" } });
    }
  },
  component: lazy(() => import("@/pages/settings")),
});

const conversationRoute = createRoute({
  getParentRoute: () => workbenchRuntimeRoute,
  path: "/c/$conversationId",
  loader: async ({ params }) => {
    const cachedConversations = queryClient.getQueriesData<{ conversations: Conversation[] }>({
      queryKey: conversationKeys.all,
    });
    if (
      cachedConversations.some(([, data]) =>
        data?.conversations.some((conversation) => conversation.conversationId === params.conversationId)
      )
    ) {
      return;
    }

    try {
      await conversationsApi.get(params.conversationId);
    } catch {
      throw redirect({ to: "/" });
    }
  },
  component: WorkbenchPage,
});

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "*",
  component: lazy(() => import("@/pages/not-found")),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    workbenchRuntimeRoute.addChildren([indexRoute, conversationRoute]),
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsCategoryRoute,
      settingsAdminCategoryRoute,
    ]),
  ]),
  notFoundRoute,
]);

const basepath = normalizeBasePath(import.meta.env.BASE_URL);

export const router = createRouter({
  routeTree,
  ...(basepath ? { basepath } : {}),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
