import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { pageWindow } from "../../common/dto/pagination-query.dto";
import { UpdateWorkspaceDto } from "../dto/update-workspace.dto";
import { WorkspaceService } from "../workspace.service";
import { AdminWorkspaceListQueryDto } from "./admin-workspace-query.dto";

@Controller("admin/workspaces")
@Roles("admin")
export class AdminWorkspaceController {
  constructor(private workspaceService: WorkspaceService) {}

  @Get("all")
  listAll(@Query() query: AdminWorkspaceListQueryDto) {
    const { take, skip } = pageWindow(query);
    return this.workspaceService.listAll({ take, skip });
  }

  @Post("update")
  update(@Body() body: UpdateWorkspaceDto) {
    return this.workspaceService.updateAny(
      body.id,
      body.name,
      body.description
    );
  }
}
