import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerImage, WORKER_IMAGE_TAG } from "./build-worker.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SOURCE_PATHS = [
  "apps/runtime",
  "packages/shared",
  "packages/adapters",
  "packages/agent-sdk",
  "packages/agent-acp",
  "packages/runtime-sdk",
  "packages/runtime-docker",
];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".turbo", ".next"]);

function checkWorkerImageExists() {
  const result = spawnSync("docker", ["image", "inspect", WORKER_IMAGE_TAG], {
    stdio: "pipe",
  });
  return result.status === 0;
}

async function ensureWorkerImage({ interactive, shouldReset, promptYesNo }) {
  const imageExists = checkWorkerImageExists();

  if (!imageExists) {
    console.log("🛠️  agework/runtime 镜像不存在，开始构建...");
    buildWorkerImage();
    return;
  }

  if (interactive) {
    const shouldRebuild = await promptYesNo(
      "agework/runtime 镜像已存在，是否重新构建？",
      false
    );
    if (shouldRebuild) {
      console.log("🛠️  重新构建 agework/runtime 镜像...");
      buildWorkerImage();
    } else {
      console.log("✅ 使用现有 agework/runtime 镜像");
    }
  } else if (shouldReset) {
    console.log("🛠️  --reset 模式，重新构建 agework/runtime 镜像...");
    buildWorkerImage();
  } else {
    console.log("✅ agework/runtime 镜像已存在，跳过构建");
  }
}

function getWorkerImageCreatedAt() {
  const result = spawnSync(
    "docker",
    ["image", "inspect", "-f", "{{.Created}}", WORKER_IMAGE_TAG],
    { stdio: "pipe", encoding: "utf-8" }
  );
  if (result.status !== 0) return null;
  const created = new Date(result.stdout.trim());
  return Number.isNaN(created.getTime()) ? null : created;
}

function getLatestSourceMtime(relativePaths) {
  let latest = 0;

  const walk = (path) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (SKIP_DIR_NAMES.has(path.split("/").pop())) return;
      for (const entry of readdirSync(path)) {
        walk(join(path, entry));
      }
    } else if (stats.mtimeMs > latest) {
      latest = stats.mtimeMs;
    }
  };

  for (const relativePath of relativePaths) {
    const absolutePath = resolve(repoRoot, relativePath);
    if (existsSync(absolutePath)) walk(absolutePath);
  }

  return latest;
}

function isWorkerImageStale() {
  const createdAt = getWorkerImageCreatedAt();
  if (createdAt === null) return false;

  const latestSourceMtime = getLatestSourceMtime(WORKER_SOURCE_PATHS);
  return latestSourceMtime > createdAt.getTime();
}

export {
  WORKER_IMAGE_TAG,
  buildWorkerImage,
  checkWorkerImageExists,
  ensureWorkerImage,
  isWorkerImageStale,
};
