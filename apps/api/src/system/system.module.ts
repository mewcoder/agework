import { Module } from "@nestjs/common";
import { SystemController } from "./system.controller";
import { SystemInitService } from "./init/system-init.service";
import { SystemService } from "./system.service";
import { UserModule } from "../users/user.module";

@Module({
  imports: [UserModule],
  controllers: [SystemController],
  providers: [SystemService, SystemInitService],
  exports: [SystemService],
})
export class SystemModule {}
