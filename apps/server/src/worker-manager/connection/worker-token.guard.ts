import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import {
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import type { RuntimeHost } from "@agework/runtime/host";
import { Inject } from "@nestjs/common";
import { MANAGED_RUNTIME_HOST } from "../contract/managed-runtime-host";

type WorkerTokenRequest = {
  params?: { workerId?: string };
  headers: Record<string, string | string[] | undefined>;
};

/**
 * commands/runConfig/events 三个 worker 端点共用的 token 校验:请求必须带
 * `x-agework-worker-token` header,且与该 worker 当前活跃行的 startToken 相符,
 * 否则 410——参照 Task 4 register 握手引入的 startToken 机制,把校验范围
 * 扩到剩下三个端点。不匹配统一 410 而非 401/403,让 worker 侧据此判定
 * "自己已被驱逐,直接退出"而不是重试。
 *
 * workerId 解析优先用路由参数(commands 端点自带 :workerId),没有路由参数时
 * (runs 相关的两个端点)退回读 `x-agework-worker-id` header——只有常驻 worker
 * 进程本身会直接调用这三个端点,同一进程发出的所有请求共享同一个 workerId/token,
 * 不需要为此反查 runId 归属哪个 worker。
 *
 * register 端点不接这个 guard:它靠 body 里的 startToken 匹配
 * WorkerHandshakeStore 里等待中的握手,是另一套机制。
 *
 * Phase 2 执行面搬家：校验对象是进程内 RuntimeHost 的 worker 池(Worker 表停写)。
 * 不在池中的 worker(server 重启前的旧容器、registered Host 的 worker)一律 410,
 * worker 侧收到 410 判定自己被驱逐,直接退出——这同时就是孤儿容器的自清路径。
 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  constructor(
    @Inject(MANAGED_RUNTIME_HOST) private readonly managedHost: RuntimeHost
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<WorkerTokenRequest>();
    const workerId =
      request.params?.workerId ?? request.headers[WORKER_ID_HEADER];
    const token = request.headers[WORKER_TOKEN_HEADER];
    if (!workerId || typeof workerId !== "string" || typeof token !== "string") {
      throw new HttpException(
        "missing worker token or worker id",
        HttpStatus.GONE
      );
    }
    if (!this.managedHost.validateWorkerToken(workerId, token)) {
      throw new HttpException(
        `worker token rejected for worker ${workerId}`,
        HttpStatus.GONE
      );
    }
    return true;
  }
}
