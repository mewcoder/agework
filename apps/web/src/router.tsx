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
import { normalizeBasePath } from "@/utils/path";
import WorkbenchPage, { WorkbenchRuntimeLayout } from "@/pages/workbench";
import type { Conversation } from "@/api/conversations";
import type { AuthConfigResponse } from "@agework/shared/api";

const LoginPage = lazy(() => import("@/pages/login"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const NotFoundPage = lazy(() => import("@/pages/not-found"));

function applyAuthConfig(config: AuthConfigResponse) {
  const store = useAuthStore.getState();
  store.setAuthRequired(config.authRequired);
  store.setSetupRequired(config.setupRequired);
  store.setAppName(config.appName);
  document.title = config.appName;

  if (config.setupRequired) {
    store.logout();
    queryClient.removeQueries({ queryKey: ["auth", "me"] });
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
      // 开发免登录时，后端始终以真实 admin 身份响应，刷新本地缓存避免与后端状态不一致
      if (!config.authRequired) {
        const user = await queryClient.fetchQuery({
          queryKey: ["auth", "me"],
          queryFn: () => authApi.me(),
          staleTime: 5 * 60 * 1000,
        });
        useAuthStore.getState().setAuth(null, user);
      }
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
          if (!config.authRequired) {
            const user = await queryClient.fetchQuery({
              queryKey: ["auth", "me"],
              queryFn: () => authApi.me(),
              staleTime: 5 * 60 * 1000,
            });
            useAuthStore.getState().setAuth(null, user);
          }
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
  component: LoginPage,
});

// 认证后可访问的布局层
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  beforeLoad: () => {
    const { token, authRequired, setupRequired, user } = useAuthStore.getState();
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
  component: SettingsPage,
});

const conversationRoute = createRoute({
  getParentRoute: () => workbenchRuntimeRoute,
  path: "/c/$conversationId",
  loader: async ({ params }) => {
    const cachedConversations = queryClient.getQueriesData<{ conversations: Conversation[] }>({
      queryKey: ["conversations"],
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
  component: NotFoundPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([
    workbenchRuntimeRoute.addChildren([indexRoute, conversationRoute]),
    settingsRoute,
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
