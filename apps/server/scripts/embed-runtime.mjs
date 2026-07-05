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
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
        `(pnpm --filter @agework/runtime build); turbo ^build normally handles this.`
    );
  }

  copyFileSync(source, dest);
  console.log(`embedded agework-runtime → ${dest}`);
}
