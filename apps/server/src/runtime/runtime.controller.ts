import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtUser } from "../auth/decorators/current-user.decorator";
import { RuntimeService } from "./runtime.service";
import { CreateRuntimeDto } from "./dto/create-runtime.dto";
import { RuntimeIdDto } from "./dto/runtime-id.dto";

/** Registered Runtime 配对管理("我的运行环境"页):list/create/delete。 */
@Controller("runtimes")
export class RuntimeController {
  constructor(private readonly runtimeService: RuntimeService) {}

  @Get("list")
  list(@CurrentUser() user: JwtUser) {
    return this.runtimeService.list(user.userId);
  }

  @Post("create")
  create(@Body() body: CreateRuntimeDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.create(user.userId, body.name);
  }

  @Post("delete")
  delete(@Body() body: RuntimeIdDto, @CurrentUser() user: JwtUser) {
    return this.runtimeService.delete(user.userId, body.id);
  }
}
