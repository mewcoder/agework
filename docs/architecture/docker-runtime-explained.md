# Docker / Runtime 相关文件讲解（入门）

本文用大白话解释项目里和 Docker、OpenSandbox、worker 镜像相关的文件分别是干什么的，
面向不熟悉 Docker 的读者。涉及的运行时（runtime provider）实现细节见
`apps/server/src/runtime/`，更深入的设计文档见 `docs/opensandbox-setup.md` 和
`docs/archive/superpowers/specs/`。

## 1. 为什么要用 Docker

这个项目的核心是"让 AI agent 帮用户干活"：agent 会执行命令、改文件、装依赖。
这些动作**不能直接在服务器主机上跑**——太危险了，agent 可能误删文件、装坏环境，
不同用户之间也会互相污染。

所以需要把 agent 关进一个隔离的"小盒子"里干活，这个盒子就是**容器（container）**，
由 Docker 来造。

项目里有两种运行时类型，由环境变量 `AGEWORK_RUNTIME_ALLOWED_TYPES` 控制（逗号分隔，如 `local,sandbox`）：

| 运行时类型 | 说明 | 需要 Docker？ |
|---|---|---|
| **local** | 不隔离，直接在主机上跑 agent。开发图省事用，桌面客户端默认用这种 | 不需要 |
| **sandbox** | 在容器里跑 agent，隔离宿主机。sandbox 内部有多种引擎可选 | 取决于引擎 |

sandbox 类型下，由 `AGEWORK_SANDBOX_ENGINE` 环境变量选择具体引擎：

| 引擎 | 说明 |
|---|---|
| **docker** | 直接调用 Docker API 造盒子 |
| **opensandbox** | 用阿里的 OpenSandbox 套件来更安全地造盒子、管理盒子生命周期 |

sandbox 模式下不管用哪种引擎，都需要一个"装好了 agent 运行环境的镜像"——这就是 `agework/worker`。

## 2. 核心概念速查表

| 词 | 大白话 |
|---|---|
| **镜像（image）** | 一个"安装包/模板"，里面打包好了系统 + Node + 项目代码。是静态的、只读的 |
| **容器（container）** | 用镜像"运行起来"的实例，是真正在跑的那个盒子。镜像是模具，容器是用模具做出来的成品 |
| **Dockerfile** | 一张"怎么做这个镜像"的菜谱：从什么基础系统开始、装什么、复制哪些代码进去 |
| **docker-compose.yml** | 一张"怎么把一个/多个容器跑起来"的配置单：用哪个镜像、开哪个端口、挂载哪些目录 |
| **挂载（volume / mount）** | 把主机上的某个文件夹"借"给容器用，让容器内外能共享文件 |
| **tag（如 `:latest`）** | 镜像的版本号标签。`latest` 表示"最新版" |

## 3. 逐个文件讲解

### 3.1 `apps/worker/Dockerfile` —— 造 worker 镜像的菜谱

这张菜谱分两段：第一段（`builder`）从 `node:22-slim` 开始 → 把整个 monorepo 代码复制进去 →
用 pnpm 装依赖 → 用 esbuild 把 worker 自己和它依赖的 `@agework/shared`、`@agework/adapters`
源码打包成单个 `dist/main.js`。第二段是真正的运行镜像：只装 `@anthropic-ai/claude-agent-sdk`
和 `@openai/codex-sdk` 这两个无法打包的 SDK（它们自带子进程/二进制资源），拷入打包好的
`dist/main.js`，创建一个非 root 用户 `agent` 来运行（因为 Claude CLI 拒绝在 root 下使用
bypassPermissions）→ 最后用 `node dist/main.js` 启动 worker，不再需要 `tsx`/TS 源码。

执行这张菜谱（`docker build`）后，就得到 `agework/worker:latest` 这个镜像。
后面 docker / opensandbox 模式造的每个"盒子"，都是用这个镜像启动的。

> 注意：因为依赖 monorepo 内的工作区包，构建上下文（context）必须是仓库根目录，
> 不能只用 `apps/worker` 目录构建：
> ```bash
> docker build -t agework/worker:latest -f apps/worker/Dockerfile .
> ```

### 3.2 `infra/opensandbox/docker-compose.yml` —— 把 OpenSandbox 服务器跑起来的配置单

注意：这个文件**不是用来跑 worker 的**，是用来跑 **OpenSandbox 这套"盒子管理系统"
本身**（它自己也是一个容器）。逐项解释：

```yaml
services:
  opensandbox-server:
    image: opensandbox/server:latest      # 用阿里官方的 OpenSandbox 服务器镜像
    container_name: agework-opensandbox-server
    ports:
      - "8080:8080"                       # 容器的 8080 映射到主机 8080，
                                           # 你的后端 (apps/server) 通过它通信
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
        # 把主机的 Docker 控制权"借"给它，让它能替你的后端去造/管理盒子
        # （注释里也提示了：这会带来容器逃逸风险，生产环境需谨慎）

      - ./infra/opensandbox/config.toml:/etc/opensandbox/config.toml:ro
        # 把 3.3 节的配置文件借给它读（只读）

      - opensandbox-data:/root/.opensandbox
        # OpenSandbox 自己的数据目录（持久化卷）

      - ~/.agework/workspaces:/Users/mew/.agework/workspaces:ro
        # 把用户的工作目录借给它，让造出来的盒子里能读到用户文件
        # ⚠️ 这一行目前写死了用户名 mew 的路径，换电脑/换用户会失效

    environment:
      SANDBOX_CONFIG_PATH: /etc/opensandbox/config.toml
      OPENSANDBOX_INSECURE_SERVER: "YES"  # 本地开发用的"不设密钥也能启动"开关，生产不要开

    extra_hosts:
      - "host.docker.internal:host-gateway"  # 让容器能访问主机网络

    restart: unless-stopped
```

OpenSandbox server 就像一个"盒子工厂的总控台"：你的后端告诉它"给这个用户造个盒子"，
它就用 `agework/worker` 镜像、按 3.3 节的规矩造一个出来。

### 3.3 `infra/opensandbox/config.toml` —— OpenSandbox 工厂的设置

`infra` 是 "infrastructure（基础设施）" 的缩写，习惯上用来放这类"环境/部署配置"文件。
这个 `config.toml` 是给 3.2 节里的 OpenSandbox server 读的设置，规定它造盒子时的规矩：

```toml
[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.18"   # 盒子里负责"执行命令"的组件镜像

[egress]
image = "opensandbox/egress:v1.1.0"         # 负责管控盒子网络出口的组件镜像

[docker]
drop_capabilities = [...]   # 禁止盒子使用一些危险的系统权限（安全加固）
no_new_privileges = true    # 禁止盒子内提权
pids_limit = 4096           # 限制盒子里最多能开多少进程（防止滥用）

[storage]
allowed_host_paths = ["/Users/mew/.agework/workspaces"]
  # 只允许挂载这个目录给盒子
  # ⚠️ 同样写死了用户路径，且必须和 3.2 节挂载的路径保持一致
```

这里的 `execd`、`egress` 是 **OpenSandbox 自带的"零件"镜像**，不是本项目构建的——
OpenSandbox server 运行时会自动从 Docker Hub 按需拉取。你只需要关心
`agework/worker` 这一个镜像，由 `apps/worker/Dockerfile` 构建。

镜像版本号（`v1.0.18`、`v1.1.0`）需要和实际拉取/已缓存的镜像版本对应，
若手动清理过本地镜像，首次创建盒子时会按这里指定的版本重新拉取。

## 4. 完整链路图

### opensandbox 模式

```
你的后端 (apps/server)
   │  "给用户 A 造一个盒子"
   ▼
OpenSandbox server   ← infra/opensandbox/docker-compose.yml 启动，
   │                     按 infra/opensandbox/config.toml 的规矩工作
   │  用 agework/worker 镜像造盒子
   ▼
worker 容器（盒子）   ← apps/worker/Dockerfile 构建出的镜像
   │  agent 在这个盒子里执行命令、改文件
   ▼
挂载了 ~/.agework/workspaces，能读写用户的工作目录
```

### docker 模式

省掉中间的 OpenSandbox server，后端直接用同一个 `agework/worker` 镜像，
自己调用 Docker 造盒子、管理生命周期：

```
你的后端 (apps/server) ──直接用 Docker── worker 容器（盒子）
                                        agework/worker 镜像
```

### local 模式

不造盒子，agent 直接在主机进程里跑，**完全不需要 Docker**。
这是开发时的默认方式，也是未来打包成桌面客户端时会用的方式：

```
你的后端 (apps/server) ──直接执行── agent 进程（无隔离，跑在主机上）
```

## 5. 小结：哪些是"本项目的东西"，哪些是"借来的"

| 镜像/文件 | 来源 | 是否本项目构建/维护 |
|---|---|---|
| `agework/worker:latest` | `apps/worker/Dockerfile` | ✅ 本项目构建 |
| `opensandbox/server:latest` | 阿里官方发布 | ❌ 直接拉取使用 |
| `opensandbox/execd:v1.0.18`、`opensandbox/egress:v1.1.0` | 阿里官方发布，OpenSandbox server 按需自动拉取 | ❌ 不需要手动管理 |

简单说：**只有 `agework/worker` 这一个镜像是你需要关心"怎么造、什么时候重新构建"的**，
其余都是 OpenSandbox 生态自带的零件，按版本号自动拉取即可。
