import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { AUTH_THROTTLERS } from "./guards/auth-throttler";
import { SessionService } from "./session/session.service";
import { SessionRepository } from "./session/session.repository";
import { SessionRevocationListener } from "./session/session-revocation.listener";
import { getJwtSecret } from "../config/config.service";
import { UserModule } from "../users/user.module";

@Module({
  imports: [
    UserModule,
    ThrottlerModule.forRoot(AUTH_THROTTLERS),
    JwtModule.register({
      secret: getJwtSecret(),
      signOptions: { expiresIn: "15m" },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    SessionRepository,
    SessionRevocationListener,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
