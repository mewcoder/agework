import { Module } from "@nestjs/common";
import { WorkspaceDirectoryService } from "./workspace-directory.service";

@Module({
  providers: [WorkspaceDirectoryService],
  exports: [WorkspaceDirectoryService],
})
export class WorkspaceDirectoryModule {}
