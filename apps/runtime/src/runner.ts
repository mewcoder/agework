import { runRunner } from "@agework/worker";

/**
 * agework-runtime 的 runner 入口:per-run 执行单元,独立产物(dist/runner.js),
 * 由 worker 的 RunnerManager 直接 fork 这个文件,不经 AGEWORK_WORKER_ROLE 分派、
 * 不与 main.ts(manager/worker)共享入口。见 packages/worker/docs/adr/0001。
 */
runRunner().catch((err: unknown) => {
  console.error(
    `[agework-runtime] runner fatal: ${err instanceof Error ? err.stack : String(err)}`
  );
  process.exit(1);
});
