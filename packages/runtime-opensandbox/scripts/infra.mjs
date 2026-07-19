import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkerImage,
  WORKER_IMAGE_TAG,
  checkWorkerImageExists,
  ensureWorkerImage,
  isWorkerImageStale,
} from "../../../scripts/worker-image.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const COMPOSE_FILE = "infra/opensandbox/docker-compose.yml";
const CONFIG_TOML = "infra/opensandbox/config.toml";
const HEALTH_URL = "http://127.0.0.1:8080/health";
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
      "⚠️  Runtime 源码比 agework/runtime:latest 镜像新，建议执行 pnpm --filter @agework/runtime-opensandbox infra:rebuild"
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
      console.error("Usage: node scripts/infra.mjs <up|down|logs|health|rebuild>");
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
