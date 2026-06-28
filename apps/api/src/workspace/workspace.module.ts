import { Module } from "@nestjs/common";
import { AdminWorkspaceController } from "./admin/admin-workspace.controller";
import { WorkspaceController } from "./workspace.controller";
import { WorkspaceService } from "./workspace.service";
import { WorkspaceRepository } from "./workspace.repository";
import { RunModule } from "../run/run.module";
import { WorkspaceDirectoryHandler } from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./runtime/workspace-runtime.policy";

@Module({
  imports: [RunModule],
  controllers: [WorkspaceController, AdminWorkspaceController],
  providers: [
    WorkspaceService,
    WorkspaceRepository,
    WorkspaceDirectoryHandler,
    WorkspaceRuntimePolicy,
  ],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
