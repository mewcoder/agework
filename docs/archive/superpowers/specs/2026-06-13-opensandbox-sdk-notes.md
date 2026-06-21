---
name: opensandbox-sdk-api-notes
description: OpenSandbox SDK (@alibaba-group/opensandbox) API 形状和调用序列笔记
metadata:
  type: reference
---

# OpenSandbox SDK API Notes

Package: `@alibaba-group/opensandbox` v0.1.8 (ESM, Node >= 20)

## 核心类

### ConnectionConfig

```ts
new ConnectionConfig({
  apiKey?: string,               // env: OPEN_SANDBOX_API_KEY
  domain?: string,               // default: "localhost:8080", env: OPEN_SANDBOX_DOMAIN
  protocol?: "http" | "https",   // default: "http"
  requestTimeoutSeconds?: number, // default: 30
  debug?: boolean,
  headers?: Record<string, string>,
  useServerProxy?: boolean,      // default: false
})
```

### Sandbox

```ts
// 创建
static create(opts: SandboxCreateOptions): Promise<Sandbox>

// 连接已有 sandbox
static connect(opts: SandboxConnectOptions): Promise<Sandbox>

// 恢复 paused sandbox
static resume(opts: SandboxConnectOptions): Promise<Sandbox>

// 属性
readonly id: SandboxId
readonly connectionConfig: ConnectionConfig
readonly commands: ExecdCommands
readonly files: SandboxFiles
readonly health: ExecdHealth
readonly credentialVault: CredentialVault

// 生命周期
kill(): Promise<void>
close(): Promise<void>
pause(): Promise<void>
resume(opts?): Promise<Sandbox>
renew(timeoutSeconds: number): Promise<RenewSandboxExpirationResponse>
getInfo(): Promise<SandboxInfo>
isHealthy(): Promise<boolean>

// 网络
getEndpoint(port: number): Promise<{ endpoint: string; headers?: Record<string, string> }>
getEndpointUrl(port: number): Promise<string>
getEgressPolicy(): Promise<NetworkPolicy>
patchEgressRules(rules: NetworkRule[]): Promise<void>
deleteEgressRules(targets: string[]): Promise<void>
```

### SandboxCreateOptions

```ts
interface SandboxCreateOptions {
  connectionConfig?: ConnectionConfig | ConnectionConfigOptions;
  image?: string | { uri: string; auth?: { username: string; password: string } };
  snapshotId?: string;
  entrypoint?: string[];          // default: ["tail", "-f", "/dev/null"]
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  networkPolicy?: NetworkPolicy;
  credentialProxy?: { enabled: boolean };
  volumes?: Volume[];
  extensions?: Record<string, string>;
  platform?: PlatformSpec;
  secureAccess?: boolean;
  resource?: Record<string, string>;  // default: {"cpu":"1","memory":"2Gi"}
  timeoutSeconds?: number | null;     // default: 600; null = no expiry
  skipHealthCheck?: boolean;
  healthCheck?: (sbx: Sandbox) => boolean | Promise<boolean>;
  readyTimeoutSeconds?: number;       // default: 30
  healthCheckPollingInterval?: number; // default: 200ms
}
```

### ExecdCommands

```ts
interface ExecdCommands {
  // 流式执行，返回 AsyncIterable
  runStream(command: string, opts?: RunCommandOpts, signal?: AbortSignal): AsyncIterable<ServerStreamEvent>;

  // 等待执行完成
  run(command: string, opts?: RunCommandOpts, handlers?: ExecutionHandlers, signal?: AbortSignal): Promise<CommandExecution>;

  // 中断执行
  interrupt(sessionId: string): Promise<void>;

  // 后台命令
  getCommandStatus(commandId: string): Promise<CommandStatus>;
  getBackgroundCommandLogs(commandId: string, cursor?: number): Promise<CommandLogs>;

  // Session 模式
  createSession(options?: { workingDirectory?: string }): Promise<string>;
  runInSession(sessionId: string, command: string, options?, handlers?, signal?): Promise<CommandExecution>;
  deleteSession(sessionId: string): Promise<void>;
}
```

### RunCommandOpts

```ts
interface RunCommandOpts {
  workingDirectory?: string;
  background?: boolean;
  timeoutSeconds?: number;
  uid?: number;
  gid?: number;
  envs?: Record<string, string>;
}
```

### NetworkPolicy / Egress

```ts
interface NetworkPolicy {
  defaultAction?: "allow" | "deny";
  egress?: NetworkRule[];
}

interface NetworkRule {
  action: "allow" | "deny";
  target: string;
}
```

### Volume

```ts
interface Volume {
  name: string;
  mountPath: string;
  subPath?: string;
  host?: { path: string };
  pvc?: object;
  ossfs?: { bucket: string; endpoint: string; accessKeyId: string; accessKeySecret: string; version: string };
}
```

### CredentialVault

```ts
sandbox.credentialVault.create({
  credentials: Array<{ name: string; source: { value: string } }>;
  bindings: Array<CredentialBinding>;
})

interface CredentialBinding {
  name: string;
  match: {
    schemes?: string[];
    ports?: number[];
    hosts?: string[];
    methods?: string[];
    paths?: string[];
  };
  auth: {
    type: "bearer" | "basic" | "apiKey" | "customHeaders";
    name: string;       // header name, e.g. "x-api-key" or "Authorization"
    credential: string; // reference to credential name
  };
}
```

### SandboxManager

```ts
SandboxManager.create({ connectionConfig }): SandboxManager
listSandboxInfos(query: { states?: string[]; pageSize?: number }): Promise<{ items: Array<{ id: string }> }>
close(): Promise<void>
```

### 异常

```ts
class SandboxException extends Error {
  error: { code: string; message?: string };
  requestId?: string;
}
class SandboxReadyTimeoutException extends Error {}
class SandboxApiException extends Error {}
class SandboxUnhealthyException extends Error {}
```

## MVP 最小调用序列

```ts
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox";

// 1. 创建 sandbox
const sandbox = await Sandbox.create({
  connectionConfig: new ConnectionConfig({
    domain: "localhost:8080",
    protocol: "http",
  }),
  image: "agework/worker:latest",
  timeoutSeconds: 3600,
  env: { RUNTIME_TRANSPORT: "http", AGEWORK_WORKSPACE_ID: "ws-xxx" },
  volumes: [{ name: "workspace", mountPath: "/workspace", host: { path: "/host/path" } }],
});

// 2. 执行命令
const result = await sandbox.commands.run("node /app/main.js", {
  envs: { AGEWORK_API_BASE: "http://host.docker.internal:3000" },
  background: true,
});

// 3. 获取端点
const { endpoint } = await sandbox.getEndpoint(3000);

// 4. 续期
await sandbox.renew(3600);

// 5. 销毁
await sandbox.kill();
```

## 关键发现

1. **background: true** 支持后台命令 → 可以在 sandbox 内启动常驻 worker
2. **host volume** 支持 → 可以映射 workspace 目录
3. **Credential Proxy** 需要服务端配置 egress sidecar → MVP 阶段暂不用
4. **timeoutSeconds: null** = 不自动过期 → 适合 workspace 级长期 sandbox
5. **getEndpoint / getEndpointUrl** 支持 server proxy → 适合本地和 K8s 两种部署
6. **Sandbox.connect(sandboxId)** 可以重连已有 sandbox → 适合 API 重启后恢复
