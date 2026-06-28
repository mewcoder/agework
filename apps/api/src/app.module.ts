import { existsSync } from "node:fs";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ServeStaticModule } from "@nestjs/serve-static";
import { AgentModule } from "./conversations/agent/agent.module";
import { AuthModule } from "./auth/auth.module";
import { ConfigModule } from "./config/config.module";
import { PrismaModule } from "./prisma/prisma.module";
import { WorkspaceModule } from "./workspace/workspace.module";
import { ConversationModule } from "./conversations/conversation.module";
import { ModelProviderModule } from "./model-providers/model-provider.module";
import { SystemModule } from "./system/system.module";
import { UserModule } from "./users/user.module";
import { normalizePath, resolveApiBasePath } from "./common/path.util";
import { getApiContext, isServeFrontendEnabled } from "./config/config.service";

const appContext = normalizePath(getApiContext());
const apiBasePath = resolveApiBasePath(getApiContext());
const shouldServeFrontend =
  isServeFrontendEnabled() &&
  existsSync(join(process.cwd(), "..", "web", "dist"));

@Module({
  imports: [
    ...(shouldServeFrontend
      ? [
          ServeStaticModule.forRoot({
            rootPath: join(process.cwd(), "..", "web", "dist"),
            ...(appContext ? { serveRoot: appContext } : {}),
            exclude: [`${apiBasePath}/*path`],
          }),
        ]
      : []),
    EventEmitterModule.forRoot(),
    ConfigModule,
    PrismaModule,
    AuthModule,
    UserModule,
    ConversationModule,
    WorkspaceModule,
    AgentModule,
    ModelProviderModule,
    SystemModule,
  ],
})
export class AppModule {}
