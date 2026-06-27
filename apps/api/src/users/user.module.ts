import { Module } from "@nestjs/common";
import { AdminUserController } from "./admin/admin-user.controller";
import { UserService } from "./user.service";
import { UserRepository } from "./user.repository";
import { PrismaModule } from "../prisma/prisma.module";
import { PasswordHasherService } from "./credentials/password-hasher.service";

@Module({
  imports: [PrismaModule],
  controllers: [AdminUserController],
  providers: [UserService, UserRepository, PasswordHasherService],
  exports: [UserService],
})
export class UserModule {}
