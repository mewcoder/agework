import { runManager } from "./manager/tunnel.js";

/**
 * agework-runtime 总入口,按 AGEWORK_WORKER_ROLE 三分派:
 * - 未设置(远程机器人工/systemd 直接启动)→ manager;
 * - worker|runner(由 launcher / RunnerManager 注入)→ @agework/worker 包入口
 *   (其自带 worker|runner 二分派,自执行)。
 */
async function main(): Promise<void> {
  const role = process.env.AGEWORK_WORKER_ROLE;
  if (role === "worker" || role === "runner") {
    await import("@agework/worker");
    return;
  }
  if (role !== undefined) {
    throw new Error(
      `AGEWORK_WORKER_ROLE must be unset, "worker" or "runner", got: ${role}`
    );
  }
  await runManager();
}

main().catch((err: unknown) => {
  console.error(
    `[agework-runtime] fatal: ${err instanceof Error ? err.stack : String(err)}`
  );
  process.exit(1);
});
