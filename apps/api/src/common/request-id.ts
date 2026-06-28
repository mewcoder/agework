import { generateId } from "@agework/shared";
import type { NextFunction, Request, Response } from "express";

export const REQUEST_ID_HEADER = "x-request-id";

type RequestHeaders = Record<string, string | string[] | undefined>;

export function requestIdFromHeaders(
  headers: RequestHeaders
): string | undefined {
  const header = headers[REQUEST_ID_HEADER];
  if (typeof header === "string") {
    const trimmed = header.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(header)) {
    const first = header.map((value) => value.trim()).find(Boolean);
    return first || undefined;
  }
  return undefined;
}

export function resolveRequestId(request: Pick<Request, "headers">): string {
  return requestIdFromHeaders(request.headers) ?? generateId();
}

export function requestIdMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = resolveRequestId(req);
    req.headers[REQUEST_ID_HEADER] = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}
