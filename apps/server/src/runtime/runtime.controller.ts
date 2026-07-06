import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import type { JwtUser } from "../auth/auth.types";
import { RuntimeService } from "./runtime.service";
import { CreateRuntimeDto } from "./dto/create-runtime.dto";
import { RuntimeIdDto } from "./dto/runtime-id.dto";

/**
 * Runtime 配对管理:list 对所有登录用户开放(查看可用 Runtime),
 * create/delete 限 admin(普通用户只读)。
 */
@Controller("runtimes")
export class RuntimeController {
  constructor(private readonly runtimeService: RuntimeService) {}

  /** 所有用户:列出自己可见的 Runtime(自己的 Registered + 全局 builtin)。 */
  @Get("list")
  list(@CurrentUser() user: JwtUser) {
    return this.runtimeService.list(user.userId);
  }

  /** admin:创建 Registered Runtime 并生成配对 token。 */
  @Roles("admin")
  @Post("create")
  create(@Body() body: CreateRuntimeDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.create(user.userId, body.name);
  }

  /** admin:注销 Registered Runtime(软删除)。 */
  @Roles("admin")
  @Post("delete")
  delete(@Body() body: RuntimeIdDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.delete(user.userId, body.id);
  }
}
