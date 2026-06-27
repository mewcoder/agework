import { Global, Module } from "@nestjs/common";
import { AdminConfigController } from "./admin/admin-config.controller";
import { ConfigService } from "./config.service";
import { SystemSettingRepository } from "./system-setting.repository";

@Global()
@Module({
  controllers: [AdminConfigController],
  providers: [ConfigService, SystemSettingRepository],
  exports: [ConfigService],
})
export class ConfigModule {}
