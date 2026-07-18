import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { workspaceOwnerKey } from "@agework/shared/protocol";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import {
  RUNTIME_HOST_OWNER_RECONCILIATION,
  type RuntimeHostOwnerReconciliation,
} from "../../runtime-host/runtime-host.types";
import { RunService } from "../run.service";

/**
 * workspace 删除的执行面收尾编排(方案 B:工作空间总能删,任务被停)。
 * 设计 §3.5 场景 4 要求两步有序:**先** cancel 名下活跃 run,**再** releaseOwner
 * 回收 worker——顺序保证 run 以 cancelled 而非 worker-lost error 收场。
 * 编排放本模块:run 对 workspace / runtime-host 都是合法向下依赖,是这个
 * 跨领域用例的最上层 owner。两步各自 best-effort:失败仅记录日志,不影响
 * 删除来源操作;释放遗漏由 workspace 模块的重连对账兜底。
 */
@Injectable()
export class RunWorkspaceListener {
  private readonly logger = new Logger(RunWorkspaceListener.name);

  constructor(
    private readonly runService: RunService,
    @Inject(RUNTIME_HOST_OWNER_RECONCILIATION)
    private readonly hostOwners: RuntimeHostOwnerReconciliation
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
    runtimeHostId,
  }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.runService.stopForWorkspace(workspaceId);
    } catch (err) {
      this.logger.warn(
        `stopForWorkspace failed for ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    try {
      await this.hostOwners.releaseOwner({
        runtimeHostId,
        owner: workspaceOwnerKey(workspaceId),
      });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(workspace:${workspaceId}) failed on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
