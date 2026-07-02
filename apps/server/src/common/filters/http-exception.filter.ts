import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { errorLogFields, safeLogJson } from "../logging";
import { REQUEST_ID_HEADER, resolveRequestId } from "../request-id";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) return;

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = "Internal server error";
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === "string") {
        message = res;
      } else if (typeof res === "object" && res !== null) {
        const r = res as Record<string, unknown>;
        if (typeof r.message === "string") {
          message = r.message;
        } else if (Array.isArray(r.message)) {
          message = (r.message as string[]).join("; ");
        } else if (typeof r.error === "string") {
          message = r.error;
        }
      }
    }

    const requestId = resolveRequestId(request);
    response.setHeader(REQUEST_ID_HEADER, requestId);
    this.logException(exception, {
      requestId,
      status,
      method: request.method,
      path: request.originalUrl ?? request.url,
    });

    response.status(status).json({
      code: status,
      data: null,
      message,
      requestId,
    });
  }

  private logException(
    exception: unknown,
    context: {
      requestId: string;
      status: number;
      method: string;
      path: string;
    }
  ): void {
    const payload = safeLogJson({
      ...context,
      ...errorLogFields(exception),
    });

    if (context.status >= 500) {
      this.logger.error(`request failed ${payload}`);
    } else if (context.status >= 400) {
      // 区分不同类型的 4xx 错误
      // 401/400/404: 常见客户端错误，使用 debug 避免日志噪音
      // 403/429: 可能需要关注的安全/限流问题，使用 warn
      if (
        context.status === 401 ||
        context.status === 400 ||
        context.status === 404
      ) {
        this.logger.debug(`request rejected ${payload}`);
      } else {
        this.logger.warn(`request rejected ${payload}`);
      }
    } else {
      this.logger.debug(`request exception ${payload}`);
    }
  }
}
