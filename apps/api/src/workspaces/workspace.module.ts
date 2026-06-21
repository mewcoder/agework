import { Module } from "@nestjs/common";
import { AdminWorkspaceController } from "./admin/admin-workspace.controller";
import { WorkspaceController } from "./workspace.controller";
import { WorkspaceService } from "./workspace.service";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [RuntimeModule],
  controllers: [WorkspaceController, AdminWorkspaceController],
  providers: [WorkspaceService],
})
export class WorkspaceModule {}
