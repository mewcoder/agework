import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { UpdateWorkspaceDto } from "../dto/update-workspace.dto";
import { WorkspaceService } from "../workspace.service";

@Controller("admin/workspaces")
@Roles("admin")
export class AdminWorkspaceController {
  constructor(private workspaceService: WorkspaceService) {}

  @Get("all")
  listAll(
    @Query("pageNo") pageNo?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const take = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
    const pageNum = Math.max(Number(pageNo) || 1, 1);
    return this.workspaceService.listAll({ take, skip: (pageNum - 1) * take });
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
