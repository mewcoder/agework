# 前端代码审查修复 — 设计文档

> 分支: `feat/agent-runtime-phase4-docker-http`
> 日期: 2026-06-11

## 背景

对 `apps/web` 前端代码进行系统性审查，发现 7 个值得修复的问题（3 高 + 4 中）。本文档记录修复方案的设计决策。

---

## 修复清单

| # | 严重度 | 问题 | 修复策略 |
|---|--------|------|---------|
| 1 | 🔴 高 | `useThreadAgentRuntime` 中 token 在 agent 创建时读取后不再更新 | 动态读取 |
| 2 | 🔴 高 | `doFetch` headers 合并方式不安全 | normalizeHeaders |
| 3 | 🔴 高 | clipboard 全局 monkey-patch | 局部 fallback |
| 4 | 🟡 中 | `rootRoute.beforeLoad` 每次路由变化都请求 `/auth/config` | queryClient 缓存 |
| 6 | 🟡 中 | `passwordSchema` / `usernameSchema` 重复定义 | 提取到共享模块 |
| 8 | 🟡 中 | `setTimeout` 未清理 | 去掉不必要的 / 用 ref 追踪必要的 |
| 12 | 🟡 中 | 自定义事件 `agework:thread-archived` 隐式通信 | 回调替代 CustomEvent |

---

## #1 Token 动态读取

### 问题

`useThreadAgentRuntime` 中 `HttpAgent` 在 `useMemo` 初始化时通过 `useAuthStore.getState().token` 读取 token 写入 `headers`。`useMemo` 的依赖是 `[aui, qc]`，不包含 `token`。如果用户改密后 token 更新，agent 实例仍持有旧 token，后续 SSE 请求 401。

### 方案

不将 token 写入 `HttpAgent` 初始化 headers，而是在 `instance.run` 覆写闭包中每次发起请求时动态读取 `useAuthStore.getState().token` 并更新 `instance.headers`。

`HttpAgent` 的 `headers` 是公开属性（`Record<string, string>`），在 `run` 被调用前设置即可——`run` 内部通过 `requestInit(input)` 构造 fetch 配置时会读取当前 `headers` 值。

```ts
instance.run = (params) => {
  // 每次请求时动态读取 token
  const token = useAuthStore.getState().token;
  instance.headers = {
    Accept: "text/event-stream",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  // ... 后续逻辑不变
};
```

### 涉及文件

- `lib/runtime/use-thread-agent-runtime.ts`

---

## #2 doFetch headers 合并

### 问题

`doFetch` 中用 `...(init?.headers as Record<string, string> | undefined)` 合并 headers。如果调用方传入 `Headers` 实例或二维数组（都是合法的 `HeadersInit` 类型），展开运算符不会正确合并，`authHeaders()` 的 `Authorization` 可能被丢弃。

### 方案

新增 `normalizeHeaders` 函数，安全处理 `Headers` 实例、二维数组、plain object 三种形式，统一转为 `Record<string, string>` 后再合并。

```ts
function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => { result[k] = v; });
  } else if (Array.isArray(headers)) {
    for (const [k, v] of headers) result[k] = v;
  } else {
    Object.assign(result, headers);
  }
  return result;
}
```

`doFetch` 中用 `normalizeHeaders(init?.headers)` 替代类型断言。

### 涉及文件

- `lib/http.ts`

---

## #3 Clipboard fallback

### 问题

`main.tsx` 中用 `Object.defineProperty(navigator, "clipboard", ...)` 全局 monkey-patch `navigator.clipboard`。这有三个风险：

1. `Object.defineProperty` 在 `navigator` 上可能因浏览器安全策略抛出
2. polyfill 只实现了 `writeText`，类型与完整 `Clipboard` API 不匹配
3. 全局修改宿主对象可能影响第三方库行为

### 方案

移除全局 polyfill，在 `lib/utils.ts` 中新增 `copyToClipboard` 函数，优先使用 `navigator.clipboard.writeText`，失败时 fallback 到 `document.execCommand("copy")`。

```ts
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback: execCommand（非 HTTPS 环境 clipboard API 不可用）
    const el = document.createElement("textarea");
    // ...
    document.execCommand("copy");
    // ...
  }
}
```

三处 `navigator.clipboard.writeText` 调用（`users.tsx`、`user-message.tsx`、`assistant-message.tsx`）统一替换为 `copyToClipboard`。

### 涉及文件

- `main.tsx`（移除 polyfill）
- `lib/utils.ts`（新增 `copyToClipboard`）
- `pages/admin/panels/users.tsx`
- `components/assistant-ui/user-message.tsx`
- `components/assistant-ui/assistant-message.tsx`

---

## #4 Auth config 缓存

### 问题

`router.tsx` 中 `rootRoute.beforeLoad` 每次路由变化都直接调用 `authApi.config()`，包括侧边栏切换 thread（`/` → `/t/$threadId`），导致不必要的网络请求。

### 方案

改用 `queryClient.fetchQuery`，设置 `staleTime: 5 分钟`。5 分钟内的路由切换直接命中 TanStack Query 缓存，不发请求。超过 5 分钟则后台静默刷新。

```ts
const { authRequired, appName } = await queryClient.fetchQuery({
  queryKey: ["auth", "config"],
  queryFn: () => authApi.config(),
  staleTime: 5 * 60 * 1000,
});
```

### 涉及文件

- `router.tsx`

---

## #6 Schema 重复定义

### 问题

`login.tsx`、`account.tsx`、`users.tsx` 中分别有重复的 `passwordSchema` / `usernameSchema` / `validationMessage` 定义，修改一处容易遗漏另一处。

### 方案

提取到 `utils/validation.ts` 共享模块，统一导出 `usernameSchema`、`passwordSchema`、`validationMessage`。

`account.tsx` 中原来的 `validationMessage(value)` 是特化版（只用 `passwordSchema`），改为通用版 `validationMessage(schema, value)`，调用处改为 `validationMessage(passwordSchema, newPassword)`。

### 涉及文件

- `utils/validation.ts`（新增）
- `pages/login.tsx`（删除本地定义，import 共享模块）
- `pages/settings/account.tsx`（删除本地定义，import 共享模块）
- `pages/admin/panels/users.tsx`（删除本地 `usernameSchema`，import 共享模块）

---

## #8 setTimeout 清理

### 问题

两处 `setTimeout` 缺少清理机制：

1. `useStopThreadRun` 的 `onSuccess` 中 `setTimeout(invalidate, 1500)` — 无必要且无法清理
2. `useThreadAgentRuntime` 中 `setTimeout(invalidate, 3500)` 和 `setTimeout(invalidate, 8000)` — 有必要（标题延迟刷新）但无法清理

### 方案

**#1 直接去掉**：已有乐观更新 + `invalidateQueries` + `refetchInterval: 5000`，延迟 1500ms 再 invalidate 无实际价值。

**#2 用 ref 追踪**：`setTimeout` 返回的 ID 存入 `pendingTimersRef.current`（`Set<ReturnType<typeof setTimeout>>`），timer 执行后自动从 Set 中删除。组件卸载时通过 `useEffect` cleanup 清理所有 pending timers。

```ts
const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

// run complete 中
const timers = pendingTimersRef.current;
const t1 = setTimeout(() => { timers.delete(t1); invalidate(); }, 3500);
const t2 = setTimeout(() => { timers.delete(t2); invalidate(); }, 8000);
timers.add(t1).add(t2);

// 组件卸载清理
useEffect(() => {
  const timers = pendingTimersRef.current;
  return () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}, []);
```

### 涉及文件

- `hooks/use-threads.ts`
- `lib/runtime/use-thread-agent-runtime.ts`

---

## #12 CustomEvent → 回调

### 问题

`threadListAdapter.archive` 通过 `window.dispatchEvent(new CustomEvent("agework:thread-archived", ...))` 通知 `MyRuntimeProvider`。这有三个问题：

1. **隐式通信** — 不读代码不知道这个事件存在
2. **类型需手动维护** — 需要 `global-events.d.ts` 扩展 `WindowEventMap`，detail 结构变化时需同步
3. **类型断言** — 消费方需要 `as CustomEvent<{ threadId?: string }>` 断言才能访问 detail

### 方案

将 `threadListAdapter` 从静态对象改为工厂函数 `createThreadListAdapter(onThreadArchived?)`，接受回调参数。`MyRuntimeProvider` 创建 adapter 时传入回调，回调闭包直接访问 `urlThreadId`、`qc`、`navigateRef`。

```ts
// thread-list-adapter.ts
export function createThreadListAdapter(
  onThreadArchived?: (threadId: string) => void,
): RemoteThreadListAdapter {
  return {
    // ...
    async archive(remoteId) {
      await threadsApi.archive(remoteId);
      onThreadArchived?.(remoteId);  // ← 直接回调，而非 dispatchEvent
    },
    // ...
  };
}

// MyRuntimeProvider.tsx
const adapter = useMemo(
  () =>
    createThreadListAdapter((threadId) => {
      if (threadId !== urlThreadId) return;
      const projectId = findCachedThread(qc, threadId)?.projectId;
      useChatStore.getState().startNewThread(projectId);
      navigateRef.current({ to: "/" });
    }),
  [qc, urlThreadId],
);
```

效果：
- 删除 `useEffect` 事件监听（18 行）
- 删除 `global-events.d.ts`（12 行）
- `archive` 回调通过闭包捕获上下文，无需类型断言
- 通信关系显式：`createThreadListAdapter` 的参数签名明确声明了归档后回调

### 涉及文件

- `lib/runtime/thread-list-adapter.ts`（静态对象 → 工厂函数）
- `components/MyRuntimeProvider.tsx`（传入回调，删除 useEffect 监听）
- `global-events.d.ts`（删除）