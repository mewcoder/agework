import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { RuntimeInternalAccessService } from "./access.service";
import { extractBearerToken } from "../../auth/extract-bearer-token";

type RequestWithRunId = {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  runId?: string;
  workspaceId?: string;
  runtimeResourceId?: string;
};

/**
 * 校验 worker 的 run-scoped internal access key。
 * 仅用于 /internal/runs/* 端点，与用户 JWT auth 分离。
 */
@Injectable()
export class RuntimeInternalAuthGuard implements CanActivate {
  private readonly logger = new Logger(RuntimeInternalAuthGuard.name);

  constructor(private readonly runtimeAccess: RuntimeInternalAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithRunId>();

    const accessKey = extractBearerToken(request.headers);

    if (!accessKey) {
      this.logger.warn(
        `Missing runtime access key params=${JSON.stringify(request.params)}`
      );
      throw new UnauthorizedException("Missing runtime access key");
    }

    const { runId, workspaceId, runtimeResourceId } = request.params;
    if (runId && this.runtimeAccess.verifyAccessKey(runId, accessKey)) {
      request.runId = runId;
      return true;
    }
    if (workspaceId && this.runtimeAccess.verifyWorkspaceKey(workspaceId, accessKey)) {
      request.workspaceId = workspaceId;
      return true;
    }
    if (
      runtimeResourceId &&
      this.runtimeAccess.verifyRuntimeInstanceKey(runtimeResourceId, accessKey)
    ) {
      request.runtimeResourceId = runtimeResourceId;
      return true;
    }

    this.logger.warn(
      `Invalid runtime access key diagnostics=${JSON.stringify(
        this.runtimeAccess.diagnostics({ runId, workspaceId, runtimeResourceId, accessKey })
      )}`
    );
    throw new UnauthorizedException("Invalid runtime access key");
  }
}
