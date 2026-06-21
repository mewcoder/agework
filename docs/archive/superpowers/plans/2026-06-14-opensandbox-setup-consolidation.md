# OpenSandbox 一键脚本与文件整理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 OpenSandbox 本地环境涉及的 compose 文件归并到 `infra/opensandbox/`，并新增统一脚本
`scripts/opensandbox.mjs`（CLI + 可复用模块），提供 `pnpm opensandbox:up`（一键启动/刷新）和
`pnpm opensandbox:rebuild`（重建 worker 镜像并重启），同时让 `scripts/init.mjs` 复用同一套逻辑，
去掉重复实现。

**Architecture:** 新增 `scripts/opensandbox.mjs` 导出一组纯函数（镜像检查/构建、镜像拉取、
compose 操作、健康检查、镜像过期检测），文件末尾的 CLI 入口在直接运行该脚本时调度子命令。
`scripts/init.mjs` 删除原有重复的 `ensureDockerImage`/`ensureOpenSandboxServer` 等实现，改为
import 并调用 `opensandbox.mjs` 导出的函数。`docker-compose.opensandbox.yml` 移动到
`infra/opensandbox/docker-compose.yml`，与 `config.toml` 放在同一目录。

**Tech Stack:** Node.js (ESM, `.mjs`)，`node:child_process` 调 `docker` / `docker compose` CLI，
`node:fs` 做文件遍历和 mtime 比较。无新增 npm 依赖。

---

## File Structure

- Move: `docker-compose.opensandbox.yml` → `infra/opensandbox/docker-compose.yml`
  （内部 `config.toml` 挂载路径从 `./infra/opensandbox/config.toml` 改为 `./config.toml`）
- Create: `scripts/opensandbox.mjs` — 统一 CLI + 可复用模块
- Modify: `scripts/init.mjs` — 删除重复实现，改为复用 `opensandbox.mjs`
- Modify: `package.json` — `opensandbox:*` scripts 指向新脚本/新路径，新增 `opensandbox:rebuild`
- Delete: `scripts/check-opensandbox.mjs`（功能并入 `opensandbox.mjs health`）
- Modify: `docs/opensandbox-setup.md` — 重写为新结构 + 一键命令说明

---

### Task 1: 将 docker-compose 文件移动到 `infra/opensandbox/`

**Files:**
- Create: `infra/opensandbox/docker-compose.yml`
- Delete: `docker-compose.opensandbox.yml`

- [ ] **Step 1: 创建 `infra/opensandbox/docker-compose.yml`**

内容与现有 `docker-compose.opensandbox.yml` 一致，仅将 `config.toml` 挂载路径从
`./infra/opensandbox/config.toml` 改为 `./config.toml`（因为该 compose 文件现在与
`config.toml` 同目录）：

```yaml
services:
  opensandbox-server:
    image: opensandbox/server:latest
    container_name: agework-opensandbox-server
    ports:
      - "8080:8080"
    volumes:
      # WARNING: Docker socket mounting grants container escape capabilities.
      # For production, consider using Docker-in-Docker (dind) with privileged mode
      # or rootless Docker to reduce attack surface.
      - /var/run/docker.sock:/var/run/docker.sock
      - ./config.toml:/etc/opensandbox/config.toml:ro
      - opensandbox-data:/root/.opensandbox
      - ~/.agework/workspaces:/Users/mew/.agework/workspaces:ro
    environment:
      SANDBOX_CONFIG_PATH: /etc/opensandbox/config.toml
      OPENSANDBOX_INSECURE_SERVER: "YES"  # SECURITY: Do not enable in production
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

volumes:
  opensandbox-data:
```

- [ ] **Step 2: 删除根目录的 `docker-compose.opensandbox.yml`**

```bash
git rm docker-compose.opensandbox.yml
```

- [ ] **Step 3: Commit**

```bash
git add infra/opensandbox/docker-compose.yml
git commit -m "chore: move opensandbox docker-compose into infra/opensandbox/"
```

---

### Task 2: 创建 `scripts/opensandbox.mjs` — 镜像相关函数

**Files:**
- Create: `scripts/opensandbox.mjs`

- [ ] **Step 1: 创建文件，写入 imports、常量和镜像相关函数**

```javascript
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKER_IMAGE_TAG = "agework/worker:latest";
const WORKER_DOCKERFILE = "apps/worker/Dockerfile";
const WORKER_SOURCE_PATHS = ["apps/worker", "packages/shared", "packages/adapters"];
const COMPOSE_FILE = "infra/opensandbox/docker-compose.yml";
const CONFIG_TOML = "infra/opensandbox/config.toml";
const HEALTH_URL = "http://127.0.0.1:8080/health";
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", ".next"]);

function checkWorkerImageExists() {
  const result = spawnSync("docker", ["image", "inspect", WORKER_IMAGE_TAG], {
    stdio: "pipe",
  });
  return result.status === 0;
}

function buildWorkerImage() {
  console.log(`docker build -t ${WORKER_IMAGE_TAG} -f ${WORKER_DOCKERFILE} .`);
  const result = spawnSync(
    "docker",
    ["build", "-t", WORKER_IMAGE_TAG, "-f", WORKER_DOCKERFILE, repoRoot],
    { stdio: "inherit" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Docker build failed with exit code ${result.status}`);
  }
  console.log("✅ Docker worker 镜像构建完成");
}

async function ensureWorkerImage({ interactive, shouldReset, promptYesNo }) {
  const imageExists = checkWorkerImageExists();

  if (!imageExists) {
    console.log("🛠️  Docker worker 镜像不存在，开始构建...");
    buildWorkerImage();
    return;
  }

  if (interactive) {
    const shouldRebuild = await promptYesNo(
      "Docker worker 镜像已存在，是否重新构建？",
      false
    );
    if (shouldRebuild) {
      console.log("🛠️  重新构建 Docker worker 镜像...");
      buildWorkerImage();
    } else {
      console.log("✅ 使用现有 Docker worker 镜像");
    }
  } else if (shouldReset) {
    console.log("🛠️  --reset 模式，重新构建 Docker worker 镜像...");
    buildWorkerImage();
  } else {
    console.log("✅ Docker worker 镜像已存在，跳过构建");
  }
}

function getWorkerImageCreatedAt() {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "-f", "{{.Created}}", WORKER_IMAGE_TAG],
    { stdio: "pipe", encoding: "utf-8" }
  );
  if (result.status !== 0) return null;
  const created = new Date(result.stdout.trim());
  return Number.isNaN(created.getTime()) ? null : created;
}

function getLatestSourceMtime(relativePaths) {
  let latest = 0;

  const walk = (path) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (SKIP_DIR_NAMES.has(path.split("/").pop())) return;
      for (const entry of readdirSync(path)) {
        walk(join(path, entry));
      }
    } else if (stats.mtimeMs > latest) {
      latest = stats.mtimeMs;
    }
  };

  for (const relativePath of relativePaths) {
    const absolutePath = resolve(repoRoot, relativePath);
    if (existsSync(absolutePath)) walk(absolutePath);
  }

  return latest;
}

function isWorkerImageStale() {
  const createdAt = getWorkerImageCreatedAt();
  if (createdAt === null) return false;

  const latestSourceMtime = getLatestSourceMtime(WORKER_SOURCE_PATHS);
  return latestSourceMtime > createdAt.getTime();
}

export {
  WORKER_IMAGE_TAG,
  checkWorkerImageExists,
  buildWorkerImage,
  ensureWorkerImage,
  isWorkerImageStale,
};
```

- [ ] **Step 2: 语法检查**

```bash
node --check scripts/opensandbox.mjs
```

预期：无输出（语法正确）。

- [ ] **Step 3: Commit**

```bash
git add scripts/opensandbox.mjs
git commit -m "feat: add opensandbox.mjs with worker image helpers"
```

---

### Task 3: 在 `scripts/opensandbox.mjs` 中添加 compose/健康检查/镜像拉取函数 + CLI

**Files:**
- Modify: `scripts/opensandbox.mjs`

- [ ] **Step 1: 在 Task 2 文件末尾（`export { ... }` 之前）追加以下函数**

```javascript
function runDockerCompose(args) {
  console.log(`docker compose -f ${COMPOSE_FILE} ${args.join(" ")}`);
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function composeUp() {
  runDockerCompose(["up", "-d"]);
}

function composeDown() {
  runDockerCompose(["down"]);
}

function composeLogs() {
  runDockerCompose(["logs", "-f", "opensandbox-server"]);
}

function composeRestart() {
  runDockerCompose(["restart", "opensandbox-server"]);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) {
        console.log("✅ OpenSandbox Server 已就绪");
        return;
      }
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`OpenSandbox Server 未就绪: ${lastError}`);
}

async function healthCheck() {
  try {
    const response = await fetch(HEALTH_URL);
    const body = await response.text();
    if (!response.ok) {
      console.error(`OpenSandbox health check failed: ${response.status} ${body}`);
      process.exit(1);
    }
    console.log(body);
  } catch (error) {
    console.error(
      `OpenSandbox health check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

function pullRuntimeImages() {
  const configContent = readFileSync(resolve(repoRoot, CONFIG_TOML), "utf-8");

  const images = [];
  const execdMatch = configContent.match(/execd_image\s*=\s*"([^"]+)"/);
  if (execdMatch) images.push(execdMatch[1]);

  const egressSectionMatch = configContent.match(/\[egress\]([^[]*)/);
  if (egressSectionMatch) {
    const imageMatch = egressSectionMatch[1].match(/image\s*=\s*"([^"]+)"/);
    if (imageMatch) images.push(imageMatch[1]);
  }

  for (const image of images) {
    console.log(`docker pull ${image}`);
    const result = spawnSync("docker", ["pull", image], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn(`⚠️  拉取 ${image} 失败，OpenSandbox Server 创建 sandbox 时会自动重试`);
    }
  }
}

async function cmdUp() {
  await ensureWorkerImage({ interactive: false, shouldReset: false });
  pullRuntimeImages();
  composeUp();
  await waitForHealth();
  if (isWorkerImageStale()) {
    console.log(
      "⚠️  apps/worker 源码比 agework/worker:latest 镜像新，建议执行 pnpm opensandbox:rebuild"
    );
  }
}

async function cmdRebuild() {
  buildWorkerImage();
  composeRestart();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2] ?? "up";

  switch (command) {
    case "up":
      await cmdUp();
      break;
    case "down":
      composeDown();
      break;
    case "logs":
      composeLogs();
      break;
    case "health":
      await healthCheck();
      break;
    case "rebuild":
      await cmdRebuild();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node scripts/opensandbox.mjs <up|down|logs|health|rebuild>");
      process.exit(1);
  }
}
```

- [ ] **Step 2: 更新 `export` 列表，加入新函数**

将文件末尾的 `export { ... }` 替换为：

```javascript
export {
  WORKER_IMAGE_TAG,
  checkWorkerImageExists,
  buildWorkerImage,
  ensureWorkerImage,
  isWorkerImageStale,
  pullRuntimeImages,
  composeUp,
  composeDown,
  composeLogs,
  composeRestart,
  waitForHealth,
  healthCheck,
};
```

- [ ] **Step 3: 语法检查**

```bash
node --check scripts/opensandbox.mjs
```

预期：无输出。

- [ ] **Step 4: 手动验证 `health` 子命令**

先确保 opensandbox-server 未运行时的失败路径：

```bash
node scripts/opensandbox.mjs health
```

预期：打印 `OpenSandbox health check failed: ...` 并以非 0 退出（因为容器还没启动）。

- [ ] **Step 5: Commit**

```bash
git add scripts/opensandbox.mjs
git commit -m "feat: add opensandbox.mjs compose/health helpers and CLI"
```

---

### Task 4: 更新 `scripts/init.mjs` 复用 `opensandbox.mjs`

**Files:**
- Modify: `scripts/init.mjs:1-13` (imports)
- Modify: `scripts/init.mjs:496-603` (删除重复实现)
- Modify: `scripts/init.mjs:699-705` (main 函数中的调用)

- [ ] **Step 1: 在文件顶部 import 区域追加 import**

在 `scripts/init.mjs` 第 7 行 `import * as p from "@clack/prompts";` 后新增一行：

```javascript
import {
  ensureWorkerImage,
  pullRuntimeImages,
  composeUp,
  waitForHealth,
} from "./opensandbox.mjs";
```

- [ ] **Step 2: 删除 `scripts/init.mjs` 中第 496-603 行的重复实现**

删除以下内容（`WORKER_IMAGE_TAG` 常量定义开始，到 `ensureOpenSandboxServer` 函数结束）：

```javascript
const WORKER_IMAGE_TAG = "agework/worker:latest";
const WORKER_DOCKERFILE = "apps/worker/Dockerfile";

async function ensureDockerImage({ interactive, shouldReset }) {
  const imageExists = checkDockerImageExists();

  if (!imageExists) {
    console.log("🛠️  Docker worker 镜像不存在，开始构建...");
    buildDockerImage();
    return;
  }

  // 镜像已存在
  if (interactive) {
    const shouldRebuild = await promptYesNo(
      "Docker worker 镜像已存在，是否重新构建？",
      false
    );
    if (shouldRebuild) {
      console.log("🛠️  重新构建 Docker worker 镜像...");
      buildDockerImage();
    } else {
      console.log("✅ 使用现有 Docker worker 镜像");
    }
  } else if (shouldReset) {
    console.log("🛠️  --reset 模式，重新构建 Docker worker 镜像...");
    buildDockerImage();
  } else {
    console.log("✅ Docker worker 镜像已存在，跳过构建");
  }
}

function checkDockerImageExists() {
  const result = spawnSync("docker", [
    "image",
    "inspect",
    WORKER_IMAGE_TAG,
  ], { stdio: "pipe" });
  return result.status === 0;
}

function buildDockerImage() {
  console.log(`docker build -t ${WORKER_IMAGE_TAG} -f ${WORKER_DOCKERFILE} .`);
  const result = spawnSync("docker", [
    "build",
    "-t",
    WORKER_IMAGE_TAG,
    "-f",
    WORKER_DOCKERFILE,
    repoRoot,
  ], { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Docker build failed with exit code ${result.status}`);
  }
  console.log("✅ Docker worker 镜像构建完成");
}

function runDockerCompose(args) {
  console.log(`docker compose -f docker-compose.opensandbox.yml ${args.join(" ")}`);
  const result = spawnSync("docker", [
    "compose",
    "-f",
    "docker-compose.opensandbox.yml",
    ...args,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function waitForOpenSandboxHealth() {
  const endpoint = "http://127.0.0.1:8080/health";
  const deadline = Date.now() + 30_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        console.log("✅ OpenSandbox Server 已就绪");
        return;
      }
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`OpenSandbox Server 未就绪: ${lastError}`);
}

async function ensureOpenSandboxServer() {
  console.log("🚀 启动 OpenSandbox Server...");
  runDockerCompose(["up", "-d"]);
  await waitForOpenSandboxHealth();
}

```

删除后，第 496 行（原 `const WORKER_IMAGE_TAG = ...`）的位置应直接是原第 605 行的
`async function main() {`。

- [ ] **Step 3: 更新 `main()` 中调用 OpenSandbox 相关逻辑的代码块**

找到（删除后行号会变化，按内容定位）：

```javascript
  // Docker / OpenSandbox 都依赖同一个 worker 镜像。
  if (runtimeProvider === "docker" || runtimeProvider === "opensandbox") {
    await ensureDockerImage({ interactive, shouldReset });
  }
  if (runtimeProvider === "opensandbox") {
    await ensureOpenSandboxServer();
  }
```

替换为：

```javascript
  // Docker / OpenSandbox 都依赖同一个 worker 镜像。
  if (runtimeProvider === "docker" || runtimeProvider === "opensandbox") {
    await ensureWorkerImage({ interactive, shouldReset, promptYesNo });
  }
  if (runtimeProvider === "opensandbox") {
    console.log("🚀 启动 OpenSandbox Server...");
    pullRuntimeImages();
    composeUp();
    await waitForHealth();
  }
```

- [ ] **Step 4: 语法检查**

```bash
node --check scripts/init.mjs
```

预期：无输出。

- [ ] **Step 5: 确认 `spawnSync` 仍被使用（避免遗留未用 import）**

```bash
grep -n "spawnSync" scripts/init.mjs
```

预期：仍有其它用途（例如 `runPnpm`/`runNode`/`getDbTablesWithData` 等），不需要移除该 import。
如果输出为空，则需要从 `scripts/init.mjs` 顶部的 `import { spawnSync } from "node:child_process";`
中移除 `spawnSync`。

- [ ] **Step 6: Commit**

```bash
git add scripts/init.mjs
git commit -m "refactor: reuse opensandbox.mjs helpers in init.mjs"
```

---

### Task 5: 更新 `package.json` scripts，删除 `check-opensandbox.mjs`

**Files:**
- Modify: `package.json`
- Delete: `scripts/check-opensandbox.mjs`

- [ ] **Step 1: 修改 `package.json` 中的 `opensandbox:*` scripts**

将：

```json
    "opensandbox:up": "docker compose -f docker-compose.opensandbox.yml up -d",
    "opensandbox:down": "docker compose -f docker-compose.opensandbox.yml down",
    "opensandbox:logs": "docker compose -f docker-compose.opensandbox.yml logs -f opensandbox-server",
    "opensandbox:health": "node scripts/check-opensandbox.mjs",
```

替换为：

```json
    "opensandbox:up": "node scripts/opensandbox.mjs up",
    "opensandbox:down": "node scripts/opensandbox.mjs down",
    "opensandbox:logs": "node scripts/opensandbox.mjs logs",
    "opensandbox:health": "node scripts/opensandbox.mjs health",
    "opensandbox:rebuild": "node scripts/opensandbox.mjs rebuild",
```

- [ ] **Step 2: 删除 `scripts/check-opensandbox.mjs`**

```bash
git rm scripts/check-opensandbox.mjs
```

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: route opensandbox pnpm scripts through opensandbox.mjs"
```

---

### Task 6: 重写 `docs/opensandbox-setup.md`

**Files:**
- Modify: `docs/opensandbox-setup.md`

- [ ] **Step 1: 用以下内容整体替换 `docs/opensandbox-setup.md`**

```markdown
# OpenSandbox 本地开发环境

记录 `RUNTIME_PROVIDER=opensandbox` 时涉及的文件、启动方式和常见报错排查。设计背景见
`docs/superpowers/specs/2026-06-12-opensandbox-provider-design.md` 和
`docs/superpowers/specs/2026-06-14-opensandbox-setup-consolidation-design.md`。

## 相关文件

- `infra/opensandbox/docker-compose.yml` — 定义 `opensandbox-server` 容器，挂载同目录下的
  `config.toml`、Docker socket 和 `~/.agework/workspaces`。
- `infra/opensandbox/config.toml` — OpenSandbox Server 配置：runtime 类型（docker）、
  `execd`/`egress` 镜像版本、存储白名单路径等。
- `scripts/opensandbox.mjs` — 统一入口（CLI + 可复用模块）：
  - `ensureWorkerImage()`：检查/构建 `agework/worker:latest`（execd 容器运行的 worker 镜像）
  - `pullRuntimeImages()`：从 `config.toml` 读取并拉取 `execd`/`egress` 镜像
  - `composeUp/Down/Logs/Restart()`：操作 `infra/opensandbox/docker-compose.yml`
  - `waitForHealth()` / `healthCheck()`：健康检查
  - `isWorkerImageStale()`：比较 worker 镜像构建时间与 `apps/worker`/`packages/shared`/
    `packages/adapters` 源码 mtime
- `scripts/init.mjs`（`pnpm boot` / `pnpm init:*`）— 选择 `opensandbox` 时复用
  `opensandbox.mjs` 完成镜像构建、镜像拉取、启动容器、等待健康检查
- `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts` — 后端 RuntimeProvider 实现
- `apps/api/.env` 中的 `OPENSANDBOX_*`（DOMAIN/PROTOCOL/API_KEY/IMAGE/...）

## 常用命令

```bash
pnpm opensandbox:up      # 一键：构建/检查 worker 镜像、拉取 execd/egress 镜像、启动容器、等待健康检查
pnpm opensandbox:down    # 停止容器
pnpm opensandbox:logs    # 看日志
pnpm opensandbox:health  # 健康检查（GET /health）
pnpm opensandbox:rebuild # 重新构建 worker 镜像并重启 opensandbox-server
```

修改 `apps/worker`、`packages/shared`、`packages/adapters` 源码后，再次执行
`pnpm opensandbox:up` 会提示 worker 镜像是否过期；过期时执行 `pnpm opensandbox:rebuild`
重新构建并让新 sandbox 使用新镜像。

## 常见问题

### 容器一直 Restarting，`/health` fetch failed

日志会显示：

```
API key startup confirmation failed: Startup blocked: server.api_key is empty in non-interactive mode.
Set OPENSANDBOX_INSECURE_SERVER=YES to acknowledge the risk.
```

OpenSandbox Server 在非交互模式下启动时，要求 `config.toml` 配置 `server.api_key` 或设置
`OPENSANDBOX_INSECURE_SERVER=YES`。本地开发已在 `infra/opensandbox/docker-compose.yml` 中设置
`OPENSANDBOX_INSECURE_SERVER: "YES"`（不要在生产环境启用）。

### 创建 sandbox 报 `Failed to pull image opensandbox/execd:v1.0.18: 404 ... No such image`

`config.toml` 中 `execd_image` / `egress.image` 指定的镜像（如 `opensandbox/execd:v1.0.18`、
`opensandbox/egress:v1.1.0`）不是由本项目构建的，而是 OpenSandbox Server 在创建 sandbox 时按需
从 Docker Hub 拉取。`pnpm opensandbox:up` 会先尝试 `docker pull` 这两个镜像；如果拉取失败（仅打印
警告），可以手动重试：

```bash
docker pull opensandbox/execd:v1.0.18
docker pull opensandbox/egress:v1.1.0
```

镜像版本号需与 `infra/opensandbox/config.toml` 中的 tag 保持一致。
```

- [ ] **Step 2: Commit**

```bash
git add docs/opensandbox-setup.md
git commit -m "docs: rewrite opensandbox setup guide for unified script"
```

---

### Task 7: 端到端手动验证

**Files:** 无代码改动，仅验证。

- [ ] **Step 1: 验证 `pnpm opensandbox:up`（镜像已存在场景）**

前置：确保本地已有 `agework/worker:latest` 镜像（`docker image inspect agework/worker:latest`），
若没有先运行一次让其构建。

```bash
pnpm opensandbox:up
```

预期：
- 跳过镜像构建（输出 `✅ Docker worker 镜像已存在，跳过构建` 不会出现，因为 `up` 命令的
  `ensureWorkerImage` 在 `interactive: false, shouldReset: false` 下，镜像存在时直接打印
  `✅ Docker worker 镜像已存在，跳过构建`）
- 打印 `docker pull opensandbox/execd:...` 和 `docker pull opensandbox/egress:...`
- `docker compose -f infra/opensandbox/docker-compose.yml up -d` 成功
- 最终打印 `✅ OpenSandbox Server 已就绪`

- [ ] **Step 2: 验证 `pnpm opensandbox:health`**

```bash
pnpm opensandbox:health
```

预期：打印健康检查返回的 JSON body，进程退出码为 0。

- [ ] **Step 3: 验证 `pnpm opensandbox:logs`**

```bash
timeout 5 pnpm opensandbox:logs || true
```

预期：打印 `agework-opensandbox-server` 容器日志（命令本身会因 `timeout` 在 5 秒后退出，
属于预期）。

- [ ] **Step 4: 验证 `pnpm opensandbox:rebuild`**

```bash
pnpm opensandbox:rebuild
```

预期：执行 `docker build -t agework/worker:latest ...`，构建完成后打印
`✅ Docker worker 镜像构建完成`，随后执行 `docker compose ... restart opensandbox-server`。

- [ ] **Step 5: 验证 `pnpm opensandbox:down`**

```bash
pnpm opensandbox:down
```

预期：`agework-opensandbox-server` 容器被停止/移除。

- [ ] **Step 6: 验证 `pnpm init:dev`（选择 opensandbox 分支）不报错**

```bash
RUNTIME_PROVIDER=opensandbox node scripts/init.mjs --dev --runtime opensandbox --no-install
```

预期：流程正常执行到 `ensureWorkerImage` 和 OpenSandbox 启动逻辑，不抛出 `ReferenceError`
或 `import` 错误；最终 `apps/api/.env` 中 `RUNTIME_PROVIDER=opensandbox`。

完成后可执行 `pnpm opensandbox:down` 清理容器。
```
