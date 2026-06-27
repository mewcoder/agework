import { Module } from "@nestjs/common";
import { AdminUserController } from "./admin/admin-user.controller";
import { UserService } from "./user.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PasswordHasherService } from "./password-hasher.service";

@Module({
  imports: [PrismaModule],
  controllers: [AdminUserController],
  providers: [UserService, PasswordHasherService],
  exports: [UserService, PasswordHasherService],
})
export class UserModule {}
