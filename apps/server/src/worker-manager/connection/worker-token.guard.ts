import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from "@nestjs/common";
import {
  WORKER_OWNER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";

type WorkerTokenRequest = {
  params?: { ownerId?: string };
  headers: Record<string, string | string[] | undefined>;
};

/**
 * commands/runConfig/events 三个 worker 端点共用的 token 校验:请求必须带
 * `x-agework-worker-token` header,且与该 owner 当前活跃行的 startToken 相符,
 * 否则 410——参照 Task 4 register 握手引入的 startToken 机制,把校验范围
 * 扩到剩下三个端点。不匹配统一 410 而非 401/403,让 worker 侧据此判定
 * "自己已被驱逐,直接退出"而不是重试。
 *
 * ownerId 解析优先用路由参数(commands 端点自带 :ownerId),没有路由参数时
 * (runs 相关的两个端点)退回读 `x-agework-owner-id` header——只有常驻 worker
 * 进程本身会直接调用这三个端点,同一进程发出的所有请求共享同一个 ownerId/token,
 * 不需要为此反查 runId 归属哪个 owner。
 *
 * register 端点不接这个 guard:它靠 body 里的 startToken 匹配
 * WorkerHandshakeStore 里等待中的握手,是另一套机制。
 */
@Injectable()
export class WorkerTokenGuard implements CanActivate {
  constructor(private readonly registry: WorkerRegistryRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkerTokenRequest>();
    const ownerId =
      request.params?.ownerId ?? request.headers[WORKER_OWNER_ID_HEADER];
    const token = request.headers[WORKER_TOKEN_HEADER];
    if (!ownerId || typeof ownerId !== "string" || typeof token !== "string") {
      throw new HttpException(
        "missing worker token or owner id",
        HttpStatus.GONE
      );
    }
    const active = await this.registry.findActiveByOwnerId(ownerId);
    if (!active || active.startToken !== token) {
      throw new HttpException(
        `worker token rejected for owner ${ownerId}`,
        HttpStatus.GONE
      );
    }
    return true;
  }
}
