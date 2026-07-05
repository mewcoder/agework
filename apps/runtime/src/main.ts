import { runWorker } from "@agework/worker";
import { runManager } from "./manager/tunnel.js";

/**
 * agework-runtime 总入口,按 AGEWORK_WORKER_ROLE 二分派:
 * - 未设置(远程机器人工/systemd 直接启动)→ manager;
 * - worker(由 launcher 注入)→ @agework/worker 导出的 runWorker()。
 * runner 是独立产物(见 ./runner.ts),不经这里分派——worker 的 RunnerManager
 * 直接 fork 那个文件,见 packages/worker/docs/adr/0001。
 */
async function main(): Promise<void> {
  const role = process.env.AGEWORK_WORKER_ROLE;
  if (role === "worker") {
    await runWorker();
    return;
  }
  if (role !== undefined) {
    throw new Error(`AGEWORK_WORKER_ROLE must be unset or "worker", got: ${role}`);
  }
  await runManager();
}

main().catch((err: unknown) => {
  console.error(
    `[agework-runtime] fatal: ${err instanceof Error ? err.stack : String(err)}`
  );
  process.exit(1);
});
