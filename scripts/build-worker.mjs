import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Managed 的 docker/opensandbox 载体镜像 = agework-runtime 产物镜像。
 * worker 内置其中,launcher 注入 AGEWORK_WORKER_ROLE=worker 以 worker 角色启动;
 * 同一镜像默认(无 role)= manager,Registered 远程 manager 也用它。
 * 即"worker 镜像 = runtime 镜像 = 同一产物",Worker 源码归 apps/runtime 所有。
 */
export const WORKER_IMAGE_TAG = "agework/runtime:latest";
export const WORKER_DOCKERFILE = "apps/runtime/Dockerfile";

export function buildWorkerBundle() {
  console.log("pnpm exec turbo run build --filter=@agework/runtime");
  const result = spawnSync(
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=@agework/runtime"],
    { cwd: repoRoot, stdio: "inherit" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Runtime build failed with exit code ${result.status}`);
  }
}

export function buildWorkerImage() {
  buildWorkerBundle();

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
  console.log(`✅ ${WORKER_IMAGE_TAG} 镜像构建完成`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  buildWorkerImage();
}
