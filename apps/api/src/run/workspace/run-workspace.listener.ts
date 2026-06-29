import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import { RunService } from "../run.service";

/**
 * 监听 workspace 删除事件，停止该 workspace 下的活跃 run（方案 B：工作空间总能删，
 * 任务被停）。best-effort：失败仅记录日志，不影响删除来源操作。
 */
@Injectable()
export class RunWorkspaceListener {
  private readonly logger = new Logger(RunWorkspaceListener.name);

  constructor(private readonly runService: RunService) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
  }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.runService.stopRunsForWorkspace(workspaceId);
    } catch (err) {
      this.logger.warn(
        `stopRunsForWorkspace failed for ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
