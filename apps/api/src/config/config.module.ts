import { Global, Module } from "@nestjs/common";
import { AdminConfigController } from "./admin/admin-config.controller";
import { ConfigService } from "./config.service";

@Global()
@Module({
  controllers: [AdminConfigController],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
