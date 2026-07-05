import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerImage, WORKER_IMAGE_TAG } from "./build-worker.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const WORKER_SOURCE_PATHS = ["packages/worker", "packages/shared", "packages/adapters"];
const COMPOSE_FILE = "infra/opensandbox/docker-compose.yml";
const CONFIG_TOML = "infra/opensandbox/config.toml";
const HEALTH_URL = "http://127.0.0.1:8080/health";
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
    console.log("🛠️  agework/worker 镜像不存在，开始构建...");
    buildWorkerImage();
    return;
  }

  if (interactive) {
    const shouldRebuild = await promptYesNo(
      "agework/worker 镜像已存在，是否重新构建？",
      false
    );
    if (shouldRebuild) {
      console.log("🛠️  重新构建 agework/worker 镜像...");
      buildWorkerImage();
    } else {
      console.log("✅ 使用现有 agework/worker 镜像");
    }
  } else if (shouldReset) {
    console.log("🛠️  --reset 模式，重新构建 agework/worker 镜像...");
    buildWorkerImage();
  } else {
    console.log("✅ agework/worker 镜像已存在，跳过构建");
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

function runDockerCompose(args) {
  console.log(`docker compose -f ${COMPOSE_FILE} ${args.join(" ")}`);
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function composeUp() {
  runDockerCompose(["up", "-d"]);
}

function composeDown() {
  runDockerCompose(["down"]);
}

function composeLogs() {
  runDockerCompose(["logs", "-f", "opensandbox-server"]);
}

function composeRestart() {
  runDockerCompose(["restart", "opensandbox-server"]);
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(HEALTH_URL);
      if (response.ok) {
        console.log("✅ OpenSandbox Server 已就绪");
        return;
      }
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`OpenSandbox Server 未就绪: ${lastError}`);
}

async function healthCheck() {
  try {
    const response = await fetch(HEALTH_URL);
    const body = await response.text();
    if (!response.ok) {
      console.error(`OpenSandbox health check failed: ${response.status} ${body}`);
      process.exit(1);
    }
    console.log(body);
  } catch (error) {
    console.error(
      `OpenSandbox health check failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}

function pullRuntimeImages() {
  const configContent = readFileSync(resolve(repoRoot, CONFIG_TOML), "utf-8");

  const images = [];
  const execdMatch = configContent.match(/execd_image\s*=\s*"([^"]+)"/);
  if (execdMatch) images.push(execdMatch[1]);

  const egressSectionMatch = configContent.match(/\[egress\]([^[]*)/);
  if (egressSectionMatch) {
    const imageMatch = egressSectionMatch[1].match(/image\s*=\s*"([^"]+)"/);
    if (imageMatch) images.push(imageMatch[1]);
  }

  for (const image of images) {
    console.log(`docker pull ${image}`);
    const result = spawnSync("docker", ["pull", image], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn(`⚠️  拉取 ${image} 失败，OpenSandbox Server 创建 sandbox 时会自动重试`);
    }
  }
}

async function cmdUp() {
  await ensureWorkerImage({ interactive: false, shouldReset: false });
  pullRuntimeImages();
  composeUp();
  await waitForHealth();
  if (isWorkerImageStale()) {
    console.log(
      "⚠️  packages/worker 源码比 agework/worker:latest 镜像新，建议执行 pnpm opensandbox:rebuild"
    );
  }
}

async function cmdRebuild() {
  buildWorkerImage();
  composeRestart();
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2] ?? "up";

  switch (command) {
    case "up":
      await cmdUp();
      break;
    case "down":
      composeDown();
      break;
    case "logs":
      composeLogs();
      break;
    case "health":
      await healthCheck();
      break;
    case "rebuild":
      await cmdRebuild();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: node scripts/opensandbox.mjs <up|down|logs|health|rebuild>");
      process.exit(1);
  }
}

export {
  WORKER_IMAGE_TAG,
  checkWorkerImageExists,
  buildWorkerImage,
  ensureWorkerImage,
  isWorkerImageStale,
  pullRuntimeImages,
  composeUp,
  composeDown,
  composeLogs,
  composeRestart,
  waitForHealth,
  healthCheck,
};
