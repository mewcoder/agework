import { Module } from "@nestjs/common";
import { SystemInitService } from "./init/system-init.service";
import { UserModule } from "../user/user.module";

@Module({
  imports: [UserModule],
  providers: [SystemInitService],
})
export class SystemModule {}
