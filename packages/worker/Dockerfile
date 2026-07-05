# Build context must be the monorepo root:
#   pnpm --filter @agework/worker build
#   docker build -t agework/worker:latest -f packages/worker/Dockerfile .
# (worker bundles workspace packages @agework/shared and @agework/adapters into
# dist/main.js via esbuild; this must be built locally before `docker build`,
# the image only copies the pre-built packages/worker/dist/main.js.)

FROM node:22

# Agent 任务常用的工具链：git（版本控制）、python3/pip（脚本运行）、
# curl/ca-certificates（网络请求）、unzip（解压）
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/worker/package.docker.json ./package.json
RUN npm install --omit=dev --no-package-lock
COPY packages/worker/dist/main.js ./dist/main.js

# Claude CLI 拒绝在 root/sudo 下使用 bypassPermissions，
# 所以把 node 官方镜像内置的 UID 1000 用户重命名为 agework 后运行 worker。
RUN groupmod -n agework node \
    && usermod -l agework -d /home/agework -m node \
    && mkdir -p /home/agework/.agework/logs/runtime /home/agework/workspaces \
    && chown -R agework:agework /app /home/agework

USER agework
ENV HOME=/home/agework

CMD ["node", "dist/main.js"]
