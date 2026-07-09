import "dotenv/config";
import { NestFactory, Reflector } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { networkInterfaces } from "node:os";
import { AppModule } from "./app.module";
import { securityHeaders } from "./common/security-headers";
import { requestIdMiddleware } from "./common/request-id";
import { ResponseInterceptor } from "./common/interceptors/response.interceptor";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { resolveApiBasePath } from "./common/api-path";
import { ConfigService, getApiContext } from "./config/config.service";
import { resolveNestLogLevels } from "./common/logging";
import { RedactingConsoleLogger } from "./common/redacting-console.logger";

function getLanAddress(): string | undefined {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const net = interfaces[name];
    if (!net) continue;
    for (const addr of net) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return undefined;
}

async function bootstrap() {
  const isProd = process.env.NODE_ENV === "production";

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });

  app.useLogger(
    new RedactingConsoleLogger({
      logLevels: resolveNestLogLevels(),
      json: isProd,
      colors: !isProd,
      timestamp: true,
    })
  );
  const configService = app.get(ConfigService);
  const bodyLimit = configService.getApiBodyLimit();
  const apiBasePath = resolveApiBasePath(getApiContext());

  app.use(requestIdMiddleware());
  app.use(securityHeaders());
  app.use(cookieParser());
  // 不开 CORS：前端与 API 始终同源（dev 经 Vite 代理、prod/桌面同 host），浏览器同源策略即足够。

  app.useBodyParser("json", { limit: bodyLimit });
  app.useBodyParser("urlencoded", { extended: true, limit: bodyLimit });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.setGlobalPrefix(apiBasePath.replace(/^\/+/, ""));
  app.enableShutdownHooks();
  const port = configService.getPort();
  await app.listen(port);
  const protocol = "http";
  const localUrl = `${protocol}://localhost:${port}${apiBasePath}`;
  const logger = new Logger("Bootstrap");
  logger.log(`  ➜  Local:   ${localUrl}`);
  const lan = getLanAddress();
  if (lan) {
    logger.log(`  ➜  Network: ${protocol}://${lan}:${port}${apiBasePath}`);
  }
}
bootstrap();
