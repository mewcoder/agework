import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { WorkerAccessService } from "../access/access.service";
import { extractBearerToken } from "../../common/extract-bearer-token";

type RequestWithRunId = {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  runId?: string;
  ownerId?: string;
};

/**
 * 校验 worker 的 run-scoped worker access key。
 * 仅用于 /worker/runs/* 与 /worker/owners/* 端点，与用户 JWT auth 分离。
 */
@Injectable()
export class WorkerAuthGuard implements CanActivate {
  private readonly logger = new Logger(WorkerAuthGuard.name);

  constructor(private readonly runtimeAccess: WorkerAccessService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithRunId>();

    const accessKey = extractBearerToken(request.headers);

    if (!accessKey) {
      this.logger.warn(
        `Missing runtime access key params=${JSON.stringify(request.params)}`
      );
      throw new UnauthorizedException("Missing runtime access key");
    }

    const { runId, ownerId } = request.params;
    if (runId && this.runtimeAccess.verifyAccessKey(runId, accessKey)) {
      request.runId = runId;
      return true;
    }
    if (ownerId && this.runtimeAccess.verifyOwnerKey(ownerId, accessKey)) {
      request.ownerId = ownerId;
      return true;
    }

    this.logger.warn(
      `Invalid runtime access key diagnostics=${JSON.stringify(
        this.runtimeAccess.diagnostics({ runId, ownerId, accessKey })
      )}`
    );
    throw new UnauthorizedException("Invalid runtime access key");
  }
}
