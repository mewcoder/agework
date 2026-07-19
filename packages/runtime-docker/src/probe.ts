import { execFile } from "node:child_process";

/** 单种 runtimeType 的当前可用性探测结果。 */
export type CapabilityAvailability = { available: boolean; reason?: string };

/**
 * 探测本机 docker daemon 当前是否可达(能力矩阵动态刷新用)。
 * 异步执行不阻塞事件循环;探测失败即视为不可用。
 */
export function probeDockerDaemon(
  timeoutMs = 5_000
): Promise<CapabilityAvailability> {
  return new Promise((resolve) => {
    execFile("docker", ["info"], { timeout: timeoutMs }, (err) => {
      resolve(
        err
          ? { available: false, reason: "docker daemon not reachable" }
          : { available: true }
      );
    });
  });
}
