import { Body, Controller, Get, Post } from "@nestjs/common";
import { CurrentUser } from "../../auth/current-user.decorator";
import { Roles } from "../../auth/roles.decorator";
import { ConfigService } from "../config.service";
import { ResetSettingDto } from "../dto/reset-setting.dto";
import { SetSettingDto } from "../dto/set-setting.dto";

@Roles("admin")
@Controller("admin/config")
export class AdminConfigController {
  constructor(private configService: ConfigService) {}

  @Get("list")
  list() {
    return this.configService.listSettings();
  }

  @Post("set")
  set(@Body() body: SetSettingDto, @CurrentUser() user: { userId: string }) {
    return this.configService.setSetting(body.key, body.value, user.userId);
  }

  @Post("reset")
  reset(@Body() body: ResetSettingDto) {
    return this.configService.resetSetting(body.key);
  }
}
