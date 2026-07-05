#!/usr/bin/env node
// server build 收尾:把已构建的 agework-runtime 产物内嵌进 server dist。
//
// Managed local provider fork 的是 main 这个 bundle(见 runtime/local/runtime-config.ts
// 的 resolveRuntimeEntry)。随 server 一起构建/发布,天然与 server 同版本,
// server 因此不再 require.resolve('@agework/worker')。runner.mjs 必须是 main.mjs
// 的兄弟文件——worker 进程按需 fork per-run runner 时,是从自己的入口路径推出同目录下
// 的 runner 文件名(见 packages/worker/docs/adr/0001),不靠单独配置。
//
// 产物是 ESM,落地成 `.mjs` 让 node 无视 server 的 CommonJS package 直接当 ESM 跑。
// 依赖 turbo `^build`:@agework/runtime 是 server 的 devDependency,先于 server 构建。
//
// @anthropic-ai/claude-agent-sdk / @openai/codex-sdk 是 --external,不在 bundle 里
// (见 apps/runtime/docs/adr/0001)——它们的真实二进制通过平台专属
// optionalDependencies 分发,只有一次真实 npm install 才能在这台机器上装出匹配的
// 平台包,pnpm 的隔离式 node_modules 装不出来。复用 apps/runtime/package.docker.json
// 同一份清单,在内嵌目录旁边跑一次 npm install,和 Docker 镜像构建时做的事一致。
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
        `(pnpm --filter @agework/runtime build); turbo ^build normally handles this.`
    );
  }

  copyFileSync(source, dest);
  console.log(`embedded agework-runtime → ${dest}`);
}

const manifestSource = join(repoRoot, "apps", "runtime", "package.docker.json");
copyFileSync(manifestSource, join(destDir, "package.json"));
execFileSync("npm", ["install", "--omit=dev", "--no-package-lock"], {
  cwd: destDir,
  stdio: "inherit",
});
console.log(`installed agework-runtime native deps → ${destDir}/node_modules`);
