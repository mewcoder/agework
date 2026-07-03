import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/decorators/current-user.decorator";
import { WorkspaceService } from "./workspace.service";
import { CreateWorkspaceDto } from "./dto/create-workspace.dto";
import { UpdateWorkspaceDto } from "./dto/update-workspace.dto";
import { WorkspaceIdDto } from "./dto/workspace-id.dto";

@Controller("workspaces")
export class WorkspaceController {
  constructor(private workspaceService: WorkspaceService) {}

  @Get("list")
  list(@CurrentUser() user: JwtUser) {
    return this.workspaceService.list(user.userId);
  }

  @Get("capabilities")
  capabilities() {
    return this.workspaceService.getCapabilities();
  }

  @Post("create")
  create(@Body() body: CreateWorkspaceDto, @CurrentUser() user: JwtUser) {
    return this.workspaceService.create({
      userId: user.userId,
      name: body.name,
      gitUrl: body.gitUrl,
      description: body.description,
      rootPath: body.rootPath,
      runtimeType: body.runtimeType,
      isolationScope: body.isolationScope,
    });
  }

  @Post("update")
  update(@Body() body: UpdateWorkspaceDto, @CurrentUser() user: JwtUser) {
    return this.workspaceService.update(
      user.userId,
      body.id,
      body.name,
      body.description
    );
  }

  @Post("remove")
  remove(@Body() body: WorkspaceIdDto, @CurrentUser() user: JwtUser) {
    return this.workspaceService.delete(user.userId, body.id);
  }
}
