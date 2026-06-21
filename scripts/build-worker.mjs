import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKER_IMAGE_TAG = "agework/worker:latest";
export const WORKER_DOCKERFILE = "apps/worker/Dockerfile";

export function buildWorkerBundle() {
  console.log("pnpm --filter @agework/worker build");
  const result = spawnSync(
    "pnpm",
    ["--filter", "@agework/worker", "build"],
    { cwd: repoRoot, stdio: "inherit" }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Worker build failed with exit code ${result.status}`);
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
