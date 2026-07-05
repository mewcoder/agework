#!/usr/bin/env node
// esbuild --external 后,dist/main.js 和 dist/runner.js 里的
// @anthropic-ai/claude-agent-sdk / @openai/codex-sdk import 是裸 specifier,
// 需要一份真实(非 pnpm 隔离式)node_modules 挂在 dist/ 旁边才能在运行时解析到
// 平台专属的原生二进制(见 apps/runtime/docs/adr/0001)。这里复用打 Docker 镜像
// 用的同一份 package.docker.json,跑一次真实 npm install,让 dist/ 自成一体——
// Docker、server 内嵌(复制这份 dist/node_modules)、`pnpm dev` 的本地回退路径
// (resolveRuntimeEntry 直接用这里的 dist/main.js)三处都靠它。
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(runtimeRoot, "dist");

copyFileSync(join(runtimeRoot, "package.docker.json"), join(distDir, "package.json"));
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], {
  cwd: distDir,
  stdio: "inherit",
});
console.log(`installed sdk deps → ${distDir}/node_modules`);
