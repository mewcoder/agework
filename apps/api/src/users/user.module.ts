import { Module } from "@nestjs/common";
import { AdminUserController } from "./admin/admin-user.controller";
import { UserService } from "./user.service";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [PrismaModule, AuthModule, RuntimeModule],
  controllers: [AdminUserController],
  providers: [UserService],
})
export class UserModule {}
