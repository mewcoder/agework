#!/usr/bin/env node
// server build 收尾:把已构建的 agework-runtime 产物内嵌进 server dist。
//
// Managed local provider fork 的是 main 这个 bundle(见 runtime/local/runtime-config.ts
// 的 resolveRuntimeEntry)。随 server 一起构建/发布,天然与 server 同版本,
// server 不直接消费 Runtime 内部 Worker。runner.mjs 必须是 main.mjs
// 的兄弟文件——worker 进程按需 fork per-run runner 时,是从自己的入口路径推出同目录下
// 的 runner 文件名(见 apps/runtime/docs/adr/0002),不靠单独配置。
//
// 产物是 ESM,落地成 `.mjs` 让 node 无视 server 的 CommonJS package 直接当 ESM 跑。
// 依赖 Turbo task graph:@agework/runtime 是 server 的 production dependency,先于 server 构建与 package。
//
// @anthropic-ai/claude-agent-sdk / @openai/codex-sdk 是 --external,不在 bundle 里
// (见 apps/runtime/docs/adr/0001)——它们的真实二进制(每个平台几百 MB)通过
// apps/runtime 自己的 build(scripts/install-sdk-deps.mjs)装好、由 apps/runtime
// 管理和拥有;这里只符链接过去引用,不重复装一份、也不接管管理权
// (Managed-local 本来就要求 server/worker 同机部署,repo 目录结构随之同在)。
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(serverRoot, "..", "..");

const runtimeDist = join(repoRoot, "apps", "runtime", "dist");
const destDir = join(serverRoot, "dist", "agework-runtime");
mkdirSync(destDir, { recursive: true });

for (const name of ["main", "runner"]) {
  const source = join(runtimeDist, `${name}.js`);
  const dest = join(destDir, `${name}.mjs`);

  if (!existsSync(source)) {
    throw new Error(
      `agework-runtime bundle not found at ${source}. Build it first ` +
        `(pnpm build:runtime); Turbo normally handles this.`
    );
  }

  copyFileSync(source, dest);
  console.log(`embedded agework-runtime → ${dest}`);
}

const nodeModulesSource = join(runtimeDist, "node_modules");
if (!existsSync(nodeModulesSource)) {
  throw new Error(
    `${nodeModulesSource} not found. apps/runtime's own build should have run ` +
      `scripts/install-sdk-deps.mjs and produced it; turbo ^build normally handles this.`
  );
}
const nodeModulesLink = join(destDir, "node_modules");
if (lstatSync(nodeModulesLink, { throwIfNoEntry: false })) {
  rmSync(nodeModulesLink, { recursive: true, force: true });
}
symlinkSync(relative(destDir, nodeModulesSource), nodeModulesLink, "dir");
console.log(`linked agework-runtime native deps → ${nodeModulesLink} -> ${nodeModulesSource}`);
