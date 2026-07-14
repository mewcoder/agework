import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/auth.types";
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

  @Get("git-branches/list")
  listGitBranches(@Query("gitUrl") gitUrl: string) {
    return this.workspaceService.listGitBranches(gitUrl);
  }

  @Post("create")
  create(@Body() body: CreateWorkspaceDto, @CurrentUser() user: JwtUser) {
    return this.workspaceService.create({
      userId: user.userId,
      name: body.name,
      gitUrl: body.gitUrl,
      gitBranch: body.gitBranch,
      description: body.description,
      rootPath: body.rootPath,
      runtimeType: body.runtimeType,
      scope: body.scope,
      runtimeHostId: body.runtimeHostId,
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

  // ── 文件预览(只读,经 worker 代理读) ──

  @Get("files/list")
  listFiles(
    @Query("id") id: string,
    @Query("path") path: string,
    @CurrentUser() user: JwtUser
  ) {
    return this.workspaceService.listFiles(user.userId, id, path ?? "");
  }

  @Get("files/read")
  readFile(
    @Query("id") id: string,
    @Query("path") path: string,
    @CurrentUser() user: JwtUser
  ) {
    return this.workspaceService.readFile(user.userId, id, path);
  }

  // ── 变更查看(diff,只读,仅本地 runtime) ──

  @Get("files/changes")
  listChangedFiles(@Query("id") id: string, @CurrentUser() user: JwtUser) {
    return this.workspaceService.listChangedFiles(user.userId, id);
  }

  @Get("files/diff")
  readFileDiff(
    @Query("id") id: string,
    @Query("path") path: string,
    @CurrentUser() user: JwtUser
  ) {
    return this.workspaceService.readFileDiff(user.userId, id, path);
  }

  @Get("files/search")
  searchFiles(@Query("id") id: string, @CurrentUser() user: JwtUser) {
    return this.workspaceService.searchFiles(user.userId, id);
  }
}
