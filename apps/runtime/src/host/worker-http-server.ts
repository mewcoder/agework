import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
  type RunConfig,
  type WorkerCommandRpcRequest,
  type WorkerRegisterResponse,
} from "@agework/shared/protocol";
import { commandMessageToRpcRequest } from "@agework/shared/protocol/rpc";
import { isWorkerRegisterRequest } from "@agework/shared/protocol/wire";
import { AGEWORK_VERSION } from "@agework/shared";
import type { RuntimeHost } from "./runtime-host.js";
import { WorkerEventRequestError } from "./worker-event-request.error.js";

/**
 * Runtime Host 自管的 worker HTTP 数据面服务器（builtin / registered 同构）。
 *
 * 暴露 `/worker/*` 路由；`AGEWORK_WORKER_API_BASE` 始终指向拥有该 worker 的 Host。
 *
 * 路由：
 * - GET  /worker/:workerId/commands  → runtimeHost.pollCommands()
 * - GET  /worker/runs/:runId          → runtimeHost.getRunConfig()
 * - POST /worker/:workerId/register   → runtimeHost.registerWorker()
 * - POST /worker/runs/:runId/events   → runtimeHost.postEvent()
 *
 * 鉴权：commands/runConfig/events 三个端点共用 token 校验（runtimeHost.validateWorkerToken），
 * register 靠 body 里的 startToken 匹配 Host 内的 HandshakeStore。
 */
export class WorkerHttpServer {
  private server?: Server;

  constructor(
    private readonly host: RuntimeHost,
    private readonly port: number,
    private readonly apiBasePath: string = "/api/v1"
  ) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          this.sendError(res, 500, err);
        });
      });
      this.server.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const pathname = url.pathname;

    // 剥离 API base path 前缀，剩余路径用于路由
    const route = pathname.startsWith(this.apiBasePath)
      ? pathname.slice(this.apiBasePath.length)
      : pathname;

    // GET /worker/:workerId/commands
    const commandsMatch = route.match(/^\/worker\/([^/]+)\/commands$/);
    if (commandsMatch && req.method === "GET") {
      return this.handlePollCommands(commandsMatch[1], url, req, res);
    }

    // POST /worker/:workerId/register
    const registerMatch = route.match(/^\/worker\/([^/]+)\/register$/);
    if (registerMatch && req.method === "POST") {
      return this.handleRegister(registerMatch[1], req, res);
    }

    // GET /worker/runs/:runId
    const getConfigMatch = route.match(/^\/worker\/runs\/([^/]+)$/);
    if (getConfigMatch && req.method === "GET") {
      return this.handleGetRunConfig(getConfigMatch[1], req, res);
    }

    // POST /worker/runs/:runId/events
    const postEventsMatch = route.match(/^\/worker\/runs\/([^/]+)\/events$/);
    if (postEventsMatch && req.method === "POST") {
      return this.handlePostEvents(postEventsMatch[1], req, res);
    }

    this.sendJson(res, 404, { error: "not found" });
  }

  // ── 路由处理 ────────────────────────────────────────────────────────

  private async handlePollCommands(
    workerId: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (!this.guardToken(req, res, workerId)) return;

    const afterSeq = parseInt(url.searchParams.get("afterSeq") ?? "0", 10);
    const waitMs = parseInt(url.searchParams.get("waitMs") ?? "0", 10);

    const result = await this.host.pollCommands(workerId, { afterSeq, waitMs });
    const messages: WorkerCommandRpcRequest[] = result.commands.map(
      commandMessageToRpcRequest
    );
    this.sendJson(res, 200, {
      messages,
      queueEpoch: result.queueEpoch,
    });
  }

  private async handleRegister(
    workerId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await this.readJsonBody(req);
    const protocolVersion =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? Reflect.get(body, "protocolVersion")
        : undefined;
    if (protocolVersion !== RUNTIME_WORKER_HTTP_PROTOCOL_VERSION) {
      this.sendJson(res, 409, {
        error: `incompatible worker protocol: worker=${String(protocolVersion)} host=${RUNTIME_WORKER_HTTP_PROTOCOL_VERSION}`,
      });
      return;
    }
    if (!isWorkerRegisterRequest(body)) {
      this.sendJson(res, 400, { error: "invalid worker register request" });
      return;
    }

    const accepted = this.host.registerWorker(workerId, body.startToken, {
      pid: body.pid,
    });
    if (!accepted) {
      this.sendJson(res, 400, {
        error: "no pending launch handshake, or token mismatch",
      });
      return;
    }
    // 应用版本不匹配仅告警；线协议版本已在注册解码时强校验。
    if (typeof body?.version === "string" && body.version !== AGEWORK_VERSION) {
      console.warn(
        `[agework-runtime] worker version mismatch: worker=${body.version} host=${AGEWORK_VERSION}`
      );
    }
    const response: WorkerRegisterResponse = {
      ok: true,
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
    };
    this.sendJson(res, 200, response);
  }

  private async handleGetRunConfig(
    runId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // runConfig/events 端点没有路由 :workerId 参数，退回读 header
    const workerId = req.headers[WORKER_ID_HEADER];
    if (typeof workerId !== "string" || !this.guardToken(req, res, workerId)) {
      return;
    }

    const config = this.host.getRunConfig(workerId, runId);
    if (!config) {
      this.sendJson(res, 404, { error: `Run config not found: ${runId}` });
      return;
    }
    const response: { config: RunConfig } = { config };
    this.sendJson(res, 200, response);
  }

  private async handlePostEvents(
    runId: string,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const workerId = req.headers[WORKER_ID_HEADER];
    if (typeof workerId !== "string" || !this.guardToken(req, res, workerId)) {
      return;
    }

    const body = await this.readJsonBody(req);
    try {
      const result = await this.host.postEvent(workerId, runId, body);
      this.sendJson(res, 200, result);
    } catch (err) {
      // 请求格式/归属错误是永久失败；Server/DB 等下游处理失败返回 500，
      // 让 worker 的 HTTP 重试策略保留并重投这批事件。
      this.sendError(
        res,
        err instanceof WorkerEventRequestError ? 400 : 500,
        err
      );
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  /** token 校验：不匹配返回 410，让旧 Worker 退出。 */
  private guardToken(
    req: IncomingMessage,
    res: ServerResponse,
    workerId: string
  ): boolean {
    const token = req.headers[WORKER_TOKEN_HEADER];
    if (
      typeof token !== "string" ||
      !this.host.validateWorkerToken(workerId, token)
    ) {
      this.sendJson(res, 410, {
        error: `worker token rejected for worker ${workerId}`,
      });
      return false;
    }
    return true;
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }

  private sendError(res: ServerResponse, status: number, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.sendJson(res, status, { error: message });
  }
}
