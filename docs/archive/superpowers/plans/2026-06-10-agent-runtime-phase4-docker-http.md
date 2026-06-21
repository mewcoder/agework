# Agent Runtime Phase 4 — DockerProvider + HttpTransport Implementation Plan

> **Spec 文档**：`docs/superpowers/specs/2026-06-10-agent-runtime-phase4-docker-http-design.md`
> **分支**：`feat/agent-runtime-phase3-worker-process`（先在此分支开发，完成后建 Phase 4 分支）

**Context**：Phase 3 完成了 `LocalProcessProvider` + `IpcTransport`，agent 在 API fork 的子进程中运行。Phase 4 引入 `DockerProvider` + `HttpTransport`，使 agent 能运行在 Docker 容器内，实现资源隔离和多用户安全。本期只做 Docker 方案（最简单、macOS 可用、无外部依赖）。

**Goal**：Docker 成为 `RuntimeProvider` 的第二种实现，与 `LocalProcessProvider` 并列，通过 `RuntimeProviderRegistry` 选择。选择策略：开发环境默认 `local`，配置可切换为 `docker`。

**提交约定**：AI 不自动 commit，每个 task 结束时 `git add` 暂存并给出建议 commit message。

---

## Task 1: 抽取 `RuntimeProvider` 接口 + `RuntimeProviderRegistry`

**Files (modify):**
- `packages/protocol/src/transport.ts` — 新增 `RuntimeProvider` / `RuntimeHandle` 接口定义
- `packages/protocol/src/index.ts` — 补导出
- `apps/api/src/runs/local-process-provider.service.ts` — 实现 `RuntimeProvider` 接口
- `apps/api/src/runs/runtime-provider-registry.service.ts` — **new**，provider 注册表
- `apps/api/src/runs/runs.module.ts` — 注册 registry

**Steps:**

- [ ] **Step 1.1**: 在 `packages/protocol/src/transport.ts` 新增：

  ```ts
  export interface RuntimeHandle {
    runId: string;
    providerType: "local" | "docker";
    runtimeId: string;
  }

  export interface RuntimeProvider {
    readonly type: "local" | "docker";
    start(runConfig: RunConfig): RuntimeHandle;
    sendControl(handle: RuntimeHandle, control: ControlPayload): void;
    cancel(handle: RuntimeHandle): void;
    getHandle(runId: string): RuntimeHandle | undefined;
  }
  ```

  注意：`RuntimeHandle` 不含 `child: ChildProcess` 等实现细节——那些由 provider 自己在内部管理。`LocalProcessProvider` 内部维护一个 `Map<runId, { handle: RuntimeHandle, child: ChildProcess, ... }>` 的私有映射。

- [ ] **Step 1.2**: `LocalProcessProvider` 实现 `RuntimeProvider` 接口，`start()` 返回 `RuntimeHandle`（不含 `child`），内部仍持有 `child` 引用。`type = "local"`。

- [ ] **Step 1.3**: 新增 `RuntimeProviderRegistry`：

  ```ts
  @Injectable()
  export class RuntimeProviderRegistry {
    constructor(
      private readonly localProvider: LocalProcessProvider,
      // DockerProvider 在 Task 3 加
    ) {}

    resolve(type: "local" | "docker"): RuntimeProvider {
      switch (type) {
        case "local": return this.localProvider;
        default: throw new Error(`Unknown provider: ${type}`);
      }
    }
  }
  ```

- [ ] **Step 1.4**: 更新 `RunHandle`（run-registry）中 `runtimeHandle` 类型为 `RuntimeHandle`（protocol 接口）。

- [ ] **Step 1.5**: 验证：`pnpm typecheck && pnpm test:api`

---

## Task 2: HttpTransport（worker 侧）+ worker transport 选择

**Files (new):**
- `apps/worker/src/http-transport.ts`

**Files (modify):**
- `apps/worker/src/main.ts` — 根据 `RUNTIME_TRANSPORT` env 选择 transport

**Steps:**

- [ ] **Step 2.1**: `HttpTransport` 实现 `RuntimeTransport` 接口：

  ```ts
  export class HttpTransport implements RuntimeTransport {
    private eventSeq = 0;
    private controlSeq = 0;
    private polling = true;
    private readonly apiBase: string;   // PLATFORM_API_BASE
    private readonly runId: string;     // AGEWORK_RUN_ID
    private readonly token: string;     // AGEWORK_RUNTIME_TOKEN

    async fetchRunConfig(): Promise<RunConfig> {
      // GET ${apiBase}/internal/runs/${runId}
      // Authorization: Bearer ${token}
    }

    async emit(msg: UpstreamMessage): Promise<void> {
      // POST ${apiBase}/internal/runs/${runId}/events
      // Body: envelope (with seq, ts filled in)
      // Authorization: Bearer ${token}
      // 失败重试：3 次退避（1s, 2s, 4s）
    }

    subscribeControls(cb): Unsubscribe {
      // 启动 long-polling 循环：
      // GET ${apiBase}/internal/runs/${runId}/controls?afterSeq=${controlSeq}
      // Authorization: Bearer ${token}
      // 收到 controls 后依次 callback，更新 controlSeq
    }

    async close(): Promise<void> {
      this.polling = false;
    }
  }
  ```

- [ ] **Step 2.2**: 修改 `main.ts` transport 选择逻辑：

  ```ts
  const transportType = process.env.RUNTIME_TRANSPORT ?? "ipc";
  let transport: RuntimeTransport;
  if (transportType === "http") {
    transport = new HttpTransport();
  } else {
    if (!process.send) {
      console.error("IPC transport requires fork()");
      process.exit(1);
    }
    transport = new IpcTransport();
  }
  ```

  移除 `process.send` 的前置检查（改为仅 ipc 模式检查）。

- [ ] **Step 2.3**: 验证：`pnpm typecheck`

---

## Task 3: Internal Runtime API（API 侧）+ runtime token

**Files (new):**
- `apps/api/src/runtime/runtime.controller.ts`
- `apps/api/src/runtime/runtime.module.ts`
- `apps/api/src/runtime/runtime-token.service.ts`
- `apps/api/src/runtime/runtime-auth.guard.ts`

**Steps:**

- [ ] **Step 3.1**: `RuntimeTokenService` — 生成/校验 run-scoped token：

  ```ts
  @Injectable()
  export class RuntimeTokenService {
    // 生成：JWT { runId, iat, exp }, secret = JWT_SECRET, expiresIn = 24h
    generateToken(runId: string): string;
    // 校验：verify JWT，返回 runId；过期/无效抛 401
    verifyToken(token: string): { runId: string };
  }
  ```

- [ ] **Step 3.2**: `RuntimeAuthGuard` — 校验 `Authorization: Bearer <token>`，提取 `runId` 放到 `request.runId`。类似 `JwtAuthGuard` 但用 runtime token。

- [ ] **Step 3.3**: `RuntimeController` — 内部 API 端点：

  ```ts
  @Controller("internal/runs")
  @UseGuards(RuntimeAuthGuard)
  export class RuntimeController {
    // GET /internal/runs/:runId
    // 返回 RunConfig（从内存 registry 或数据库读取）
    async getRunConfig(@Param("runId") runId: string): Promise<RunConfig>

    // POST /internal/runs/:runId/events
    // 接收 Envelope，调用 runEventBus.publish()
    // 幂等：检查 runId + seq 是否已存在（内存去重，Phase 4a 不加 RunEvent 表）
    async postEvent(@Param("runId") runId: string, @Body() envelope: Envelope)

    // GET /internal/runs/:runId/controls?afterSeq=N
    // 返回 afterSeq 之后的 control envelopes
    // Long-polling：如果暂无新 control，hold 30s 再返回空
    async pollControls(@Param("runId") runId: string, @Query("afterSeq") afterSeq: string)
  }
  ```

  幂等去重：`RunEventBus` 已有内存 `lastSeqMap`，直接复用。Phase 4a 不引入 `RunEvent` 数据库表（避免过度设计），HTTP 重试的幂等由内存 seq 去重保障。

- [ ] **Step 3.4**: Control 队列 — `LocalProcessProvider` / `DockerProvider` 调用 `sendControl()` 时，除了发给 IPC/写 Docker，还需要写入一个内存 `Map<runId, Envelope<ControlPayload>[]>` 供 `pollControls` 读取。在 `RunEventBus` 或单独的 `ControlQueue` service 中管理。

- [ ] **Step 3.5**: `RuntimeModule` 注册 controller + guard + token service。在 `AppModule` 中 import。

- [ ] **Step 3.6**: 验证：`pnpm typecheck`

---

## Task 4: DockerProvider + worker Dockerfile

**Files (new):**
- `apps/api/src/runs/docker-provider.service.ts`
- `apps/worker/Dockerfile`
- `apps/worker/.dockerignore`

**Steps:**

- [ ] **Step 4.1**: `DockerProvider` 实现 `RuntimeProvider` 接口：

  ```ts
  @Injectable()
  export class DockerProvider implements RuntimeProvider {
    readonly type = "docker";

    start(runConfig: RunConfig): RuntimeHandle {
      // 1. 生成 runtime token: runtimeTokenService.generateToken(runId)
      // 2. 确定 API base URL: configService.getApiBaseUrl()
      // 3. 确定 worker 镜像: configService.getWorkerImage() ?? "agework/worker:latest"
      // 4. 确定 mount: hostPath = runConfig.runtimePath, containerPath = "/workspace"
      // 5. 执行: docker run -d \
      //      -v ${hostPath}:/workspace \
      //      -e RUNTIME_TRANSPORT=http \
      //      -e PLATFORM_API_BASE=${apiBase} \
      //      -e AGEWORK_RUNTIME_TOKEN=${token} \
      //      -e AGEWORK_RUN_ID=${runId} \
      //      ${image}
      // 6. 记录 container id, 启动心跳检测
      // 7. 返回 RuntimeHandle { runId, providerType: "docker", runtimeId: containerId }
    }

    sendControl(handle, control) {
      // 写入 control queue（供 pollControls 读取）
    }

    cancel(handle) {
      // docker stop ${handle.runtimeId}
      // 超时 10s 后 docker kill
    }

    getHandle(runId) { ... }
  }
  ```

  Docker CLI 调用：使用 `child_process.execFile("docker", [...args])` 封装，不引入 dockerode 依赖（保持简单）。

- [ ] **Step 4.2**: `Dockerfile`：

  ```dockerfile
  FROM node:22-slim
  WORKDIR /app
  COPY package.json pnpm-lock.yaml ./
  RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod
  COPY src/ src/
  CMD ["npx", "tsx", "src/main.ts"]
  ```

  注意：worker 的 `tsx` 在 `dependencies` 中，`--prod` 安装也会包含。

- [ ] **Step 4.3**: `.dockerignore`：`node_modules`, `dist`, `*.spec.ts`

- [ ] **Step 4.4**: 更新 `RuntimeProviderRegistry` 加入 `DockerProvider`。

- [ ] **Step 4.5**: 验证：`pnpm typecheck`

---

## Task 5: Provider 选择 + AgentController 改造

**Files (modify):**
- `apps/api/src/agent/agent.controller.ts` — 用 registry 选择 provider
- `apps/api/src/config/config.service.ts` — 新增 `getRuntimeProviderType()` 配置

**Steps:**

- [ ] **Step 5.1**: `ConfigService` 新增：

  ```ts
  getRuntimeProviderType(): "local" | "docker" {
    return (process.env.RUNTIME_PROVIDER as "local" | "docker") ?? "local";
  }
  ```

- [ ] **Step 5.2**: `AgentController` 改造：

  ```ts
  // 替换直接注入 LocalProcessProvider
  constructor(
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly configService: ConfigService,
    ...
  ) {}

  // 在 run() 中：
  const providerType = this.configService.getRuntimeProviderType();
  const provider = this.runtimeProviderRegistry.resolve(providerType);
  const runtimeHandle = provider.start(runConfig);
  ```

  `stop()` 和 `answerQuestion()` 同样通过 registry resolve provider 后调用。

- [ ] **Step 5.3**: 验证：`pnpm typecheck && pnpm test:api`

---

## Task 6: 测试

**Files (new):**
- `apps/api/src/runtime/runtime-token.service.spec.ts`
- `apps/api/src/runtime/runtime.controller.spec.ts`
- `apps/api/src/runs/docker-provider.service.spec.ts`
- `apps/worker/src/http-transport.spec.ts`

**Steps:**

- [ ] **Step 6.1**: `RuntimeTokenService` 测试 — 生成/校验/过期
- [ ] **Step 6.2**: `RuntimeController` 测试 — getRunConfig / postEvent / pollControls（mock RunEventBus + ControlQueue）
- [ ] **Step 6.3**: `DockerProvider` 测试 — start/cancel（mock docker CLI）
- [ ] **Step 6.4**: `HttpTransport` 测试 — emit 重试 / control polling
- [ ] **Step 6.5**: `RuntimeProviderRegistry` 测试 — resolve local/docker
- [ ] **Step 6.6**: 最终验证：`pnpm typecheck && pnpm build && pnpm test:api`

---

## 注意事项

1. **本期不加 RunEvent 数据库表** — HTTP 幂等由内存 seq 去重保障（与 IPC 路径一致）。如果后续需要 API 重启后恢复 event，再加 inbox 表。

2. **runtime token 不存数据库** — token 是短期 JWT，生成后通过 env 注入 worker，API 不持久化。重启后旧 token 自然失效，正在运行的 Docker Run 在孤儿恢复中处理。

3. **Docker CLI 而非 dockerode** — 少一个依赖，`execFile("docker", [...])` 封装足够。后续如果需要 stream Docker logs 或 event，再引入。

4. **ControlQueue 是内存结构** — `Map<runId, Envelope<ControlPayload>[]>`，API 重启后丢失。Docker worker 的 long-polling 会拿到空结果，不会出错。

5. **Docker mount 安全** — 只挂 `${hostPath}:/workspace`，不挂 HOME、不传 DATABASE_URL/JWT_SECRET 等后端机密。`apiKey` 通过 RunConfig 传入（已经加密在 runtime token 保护下的 HTTP 通道中）。
