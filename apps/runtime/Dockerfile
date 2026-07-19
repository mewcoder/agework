# Build context must be the monorepo root:
#   pnpm exec turbo run build --filter=@agework/runtime-host
#   docker build -t agework/runtime:latest -f apps/runtime/Dockerfile .
# (runtime bundles workspace packages @agework/{worker,shared,adapters,agent-acp,runtime-docker} into
# dist/main.js + dist/runner.js via esbuild; this must be built locally before
# `docker build`, the image only copies the pre-built dist files.)
#
# 同一镜像两种角色:默认(无 AGEWORK_WORKER_ROLE)= Registered Runtime;
# launcher 注入 AGEWORK_WORKER_ROLE=worker 起 worker(worker 镜像 = 本镜像)。
# runner 是独立产物 dist/runner.js,由容器内已在跑的 worker 进程按需 fork,
# 不经这个入口(见 apps/runtime/docs/adr/0002)。

FROM node:22

# Agent 任务常用的工具链:git(版本控制)、python3/pip(脚本运行)、
# curl/ca-certificates(网络请求)、unzip(解压)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY apps/runtime/sdk-deps/package.json ./package.json
COPY apps/runtime/sdk-deps/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps/runtime/dist/main.js ./dist/main.js
COPY apps/runtime/dist/runner.js ./dist/runner.js

# Claude CLI 拒绝在 root/sudo 下使用 bypassPermissions,
# 所以把 node 官方镜像内置的 UID 1000 用户重命名为 agework 后运行。
RUN groupmod -n agework node \
    && usermod -l agework -d /home/agework -m node \
    && mkdir -p /home/agework/.agework/logs/runtime /home/agework/workspaces \
    && chown -R agework:agework /app /home/agework

USER agework
ENV HOME=/home/agework

CMD ["node", "dist/main.js"]
