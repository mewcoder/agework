import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtUser } from "../../auth/decorators/current-user.decorator";
import { Roles } from "../../auth/decorators/roles.decorator";
import { pageWindow } from "../../common/dto/pagination-query.dto";
import { CreateUserDto } from "../dto/create-user.dto";
import { UpdateUserDto } from "../dto/update-user.dto";
import { UserIdDto } from "../dto/user-id.dto";
import { UserService } from "../user.service";
import { AdminUserListQueryDto } from "./admin-user-query.dto";

@Controller("admin/users")
@Roles("admin")
export class AdminUserController {
  constructor(private usersService: UserService) {}

  @Get("list")
  list(
    @CurrentUser() user: JwtUser,
    @Query() query: AdminUserListQueryDto,
  ) {
    const { take, skip } = pageWindow(query);
    return this.usersService.list(user, { take, skip });
  }

  @Post("create")
  create(@Body() body: CreateUserDto, @CurrentUser() user: JwtUser) {
    return this.usersService.create(user, body.username, body.role);
  }

  @Post("approve")
  approve(@Body() body: UserIdDto, @CurrentUser() user: JwtUser) {
    return this.usersService.approve(body.id, user);
  }

  @Post("update")
  update(@Body() body: UpdateUserDto, @CurrentUser() user: JwtUser) {
    return this.usersService.update(body.id, body, user);
  }

  @Post("update-password")
  updatePassword(@Body() body: UserIdDto, @CurrentUser() user: JwtUser) {
    return this.usersService.resetPassword(body.id, user);
  }

  @Post("remove")
  remove(@Body() body: UserIdDto, @CurrentUser() user: JwtUser) {
    return this.usersService.delete(body.id, user);
  }
}
