import { Module } from "@nestjs/common";
import { AdminWorkspaceController } from "./admin/admin-workspace.controller";
import { WorkspaceController } from "./workspace.controller";
import { WorkspaceService } from "./workspace.service";

@Module({
  controllers: [WorkspaceController, AdminWorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
