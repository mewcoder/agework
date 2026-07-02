# Electron 桌面客户端命令

AgeWork 桌面客户端由 Electron 壳、NestJS 后端、React Web 静态产物和 Worker 共同组成。不要只构建 `apps/desktop` 壳来验证 UI；Electron 启动后由后端服务 `apps/web/dist`，所以可运行客户端需要先刷新整个 workspace 产物。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm desktop:setup` | 安装桌面客户端开发依赖。根目录 `pnpm install` 默认不会安装这些依赖。 |
| `pnpm desktop:reset` | 清空桌面客户端本地数据并重建数据库，相当于重新安装桌面客户端。会删除数据库、工作区、缓存、登录态、日志和窗口状态。 |
| `pnpm desktop:dev` | 推荐的本地客户端启动命令。先执行 workspace build，再启动 Electron。 |
| `pnpm desktop:build` | 构建可运行桌面客户端所需的全部产物：web、api、worker、desktop。 |
| `pnpm desktop:start` | 只启动当前已有的 Electron 构建产物，不重新构建。适合刚跑过 `desktop:build` 后快速重启。 |
| `pnpm desktop:typecheck` | 只检查 Electron 主进程 / preload TypeScript 类型。 |
| `pnpm desktop:test` | 运行 `apps/desktop` 下的 Vitest 测试。 |
| `pnpm desktop:resources` | 准备 electron-builder 需要的资源目录：api deploy、web dist、template db、Agent CLI 二进制。 |
| `pnpm desktop:dist:mac` | 构建全部产物、准备资源，并打包 macOS arm64 安装包。 |

## 低层命令

| 命令 | 用途 |
|---|---|
| `pnpm -C apps/desktop build` | 只编译 Electron 主进程和 preload。不会刷新 web/api/worker。 |
| `pnpm -C apps/desktop start` | 等同于启动当前已有 Electron 产物。不会重新构建。 |
| `pnpm --filter web build` | 只刷新前端静态产物。通常不要单独用于验证桌面客户端。 |
| `pnpm --filter api build` | 只刷新后端产物。 |

## 运行时排查

Electron 客户端会启动自己的后端进程，并随机选择高位本地端口，不使用默认 `3000`。

查看当前 Electron / 桌面后端进程：

```sh
ps -axo pid,ppid,command | rg "Electron.app|apps/desktop|apps/server/dist/src/main"
```

查看桌面后端日志和实际端口：

```sh
tail -f "$HOME/Library/Application Support/@agework/desktop/logs/api.log"
```

如果 UI 修改没有生效，优先确认是否运行过：

```sh
pnpm desktop:build
pnpm desktop:start
```

或者直接使用：

```sh
pnpm desktop:dev
```

如果需要把桌面客户端恢复到刚安装后的状态，先退出 AgeWork 桌面客户端，再执行：

```sh
pnpm desktop:reset
pnpm desktop:dev
```
