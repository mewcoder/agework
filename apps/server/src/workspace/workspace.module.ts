import { Module } from "@nestjs/common";
import { AdminWorkspaceController } from "./admin/admin-workspace.controller";
import { WorkspaceController } from "./workspace.controller";
import { WorkspaceService } from "./workspace.service";
import { WorkspaceRepository } from "./workspace.repository";
import { WorkspaceDirectoryHandler } from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./placement/workspace-runtime.policy";
import { ConversationModule } from "../conversation/conversation.module";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [ConversationModule, RuntimeModule],
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
