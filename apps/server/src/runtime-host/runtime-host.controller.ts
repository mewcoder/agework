import { Controller, Get, Post, Query, Body } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/auth.types";
import { RuntimeHostService } from "./runtime-host.service";
import { ListHostDirectoryDto } from "./dto/list-host-directory.dto";
import { CreateHostDirectoryDto } from "./dto/create-host-directory.dto";

/**
 * Runtime Host 用户面只读入口:查看可见 Host、浏览/新建目录。
 * 配对管理(create/delete)是 admin 专属,在 admin/admin-runtime-host.controller.ts。
 */
@Controller("runtime-hosts")
export class RuntimeHostController {
  constructor(private readonly runtimeService: RuntimeHostService) {}

  /** 所有用户:列出自己可见的 Host（自己的 registered + 全局 builtin）。 */
  @Get("list")
  list(@CurrentUser() user: JwtUser) {
    return this.runtimeService.list(user.userId);
  }

  /** 所有用户:列出自己可见的某个 Host 上 path 下的子目录（不含文件）。 */
  @Get("directories/list")
  listDirectory(
    @Query() query: ListHostDirectoryDto,
    @CurrentUser() user: JwtUser
  ) {
    return this.runtimeService.listDirectory(
      user.userId,
      query.runtimeHostId,
      query.path
    );
  }

  /** 所有用户:在自己可见的某个 Host 上新建目录。 */
  @Post("directories/create")
  createDirectory(
    @Body() body: CreateHostDirectoryDto,
    @CurrentUser() user: JwtUser
  ) {
    return this.runtimeService.createDirectory(
      user.userId,
      body.runtimeHostId,
      body.path
    );
  }
}
