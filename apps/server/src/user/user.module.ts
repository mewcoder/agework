import { Module } from "@nestjs/common";
import { AdminUserController } from "./admin/admin-user.controller";
import { UserService } from "./user.service";
import { UserRepository } from "./user.repository";
import { PrismaModule } from "../prisma/prisma.module";
import { PasswordHasherService } from "./credential/password-hasher.service";
import { UserOwnerReleaseListener } from "./owner-release/user-owner-release.listener";
import { RuntimeHostModule } from "../runtime-host/runtime-host.module";

@Module({
  imports: [PrismaModule, RuntimeHostModule],
  controllers: [AdminUserController],
  providers: [
    UserService,
    UserRepository,
    PasswordHasherService,
    UserOwnerReleaseListener,
  ],
  exports: [UserService],
})
export class UserModule {}
