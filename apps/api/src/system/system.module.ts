import { Module } from "@nestjs/common";
import { SystemController } from "./system.controller";
import { SystemInitService } from "./system-init.service";
import { SystemService } from "./system.service";

@Module({
  controllers: [SystemController],
  providers: [SystemService, SystemInitService],
})
export class SystemModule {}
