import { Logger } from "@nestjs/common";
import { tmpdir } from "os";
import { join } from "path";
import { EventType } from "@ag-ui/client";
import { generateId } from "@agework/shared";
import type {
  Options,
  ThinkingConfig,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { Subscriber } from "rxjs";
import { ClaudeAgentAdapter as AgUiClaudeAgentAdapter } from "../base";
import type { ProcessedEvent } from "../base";
import type { AgentTraceSink } from "@agework/shared/protocol";
import { pickSafeEnv } from "./safe-env";

// ── AskUserQuestion human-in-the-loop ────────────────────────────────────────
// Keyed by threadId. Stores the pending canUseTool resolver so the answer
// endpoint can resolve it when the user submits.
//
// Terminal model:问题挂起时向 AG-UI 事件流发 RUN_FINISHED{outcome:interrupt}
// 结束当前 AG-UI run(SDK 的 canUseTool promise 保持挂起,平台 run 不结束);
// 用户答复经 approval_resolved 命令携带 resumeRunId 回来,onResume 先发
// RUN_STARTED(新 runId)再解开 promise,后续事件归入续接 run。
export type PendingQuestion = {
  questions: unknown[];
  /** interrupt 对象的 id;resume[] 里的 interruptId 与之对应。 */
  interruptId: string;
  resolveAnswers: (answers: Record<string, string | string[]>) => void;
  reject: (err: Error) => void;
  rejectWithoutCleanup: (err: Error) => void;
  /** 答复携带续接 runId 时,在 resolveAnswers 之前调用,发出续接 RUN_STARTED。 */
  onResume?: (resumeRunId: string) => void;
};
// 导出仅供测试模拟跨路径竞争（AskUserQuestion vs 权限请求）；生产代码通过
// resolveQuestion/cancelQuestion/canUseTool/executePermissionRequest 访问。
export const pendingQuestions = new Map<string, PendingQuestion>();

// ── 权限请求串行队列 ─────────────────────────────────────────────────────────
// Claude Agent SDK 对 parallel tool use 会并发调用 canUseTool。若不串行化，
// 后到的权限请求会 supersede 先到的（pendingQuestions 是 per-thread 单槽），
// 导致前几个工具收到 "Superseded by new permission request" 被误 deny。
// 这里按 threadId 维护一条 promise chain：每个权限请求排队等前一个
// resolve/reject 后才真正 emit AskUserQuestion + 等待用户回答。
// 导出仅供测试重置；生产代码通过 requestToolPermission 访问。
export const permissionQueues = new Map<string, Promise<unknown>>();

/** 重置某 thread 的权限队列（仅测试用）。 */
export function __resetPermissionQueue(threadId?: string): void {
  if (threadId) permissionQueues.delete(threadId);
  else permissionQueues.clear();
}


export function resolveQuestion(
  threadId: string,
  answers: Record<string, string | string[]>,
  resumeRunId?: string
): boolean {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return false;
  pendingQuestions.delete(threadId);
  if (resumeRunId) pending.onResume?.(resumeRunId);
  pending.resolveAnswers(answers);
  return true;
}

export function cancelQuestion(threadId: string): void {
  const pending = pendingQuestions.get(threadId);
  if (!pending) return;
  pendingQuestions.delete(threadId);
  pending.reject(new Error("Question cancelled"));
}

const logger = new Logger("ClaudeAgentAdapter");
type ClaudeRunInput = Parameters<AgUiClaudeAgentAdapter["run"]>[0];
export type AgentPendingAction = "question" | null;
export type AgentPendingActionSink = (event: {
  threadId: string;
  pendingAction: AgentPendingAction;
}) => void | Promise<void>;
export type ClaudeAdapterConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  cwd?: string;
  trace?: AgentTraceSink;
  /** true = 系统环境，让 SDK 自行从本地配置文件读取认证；false = 自定义配置，禁用文件系统配置源 */
  isEnvironmentConfig?: boolean;
  pendingActionSink?: AgentPendingActionSink;
  /** 补充环境变量，自定义配置模式下注入子进程 env，可覆盖同名内置变量（ANTHROPIC_BASE_URL 等）。 */
  extraConfig?: Record<string, string>;
  /** Claude Code executable override. */
  pathToClaudeCodeExecutable?: string;
};

export class ClaudeAgentAdapter extends AgUiClaudeAgentAdapter {
  private readonly trace?: AgentTraceSink;
  private readonly pendingActionSink?: AgentPendingActionSink;
  private readonly pendingActionUpdates = new Map<string, Promise<void>>();
  // 问答续接后,同一条 SDK stream 后续事件归属的 AG-UI runId(per thread)。
  private readonly resumedRunIds = new Map<string, string>();

  constructor(opts: ClaudeAdapterConfig = {}) {
    const workdir = opts.cwd;
    const isEnvironmentConfig = !!opts.isEnvironmentConfig;
    const trace = opts.trace;
    const pendingActionSink = opts.pendingActionSink;
    logger.log(
      `config mode: ${isEnvironmentConfig ? "environment" : "custom"}, ` +
        `workdir: ${workdir ?? "(not set)"}, ` +
        `model: ${opts.model ?? "(not set)"}, ` +
        `baseUrl: ${opts.baseUrl ?? "(not set)"}, ` +
        `apiKey: ${opts.apiKey ? opts.apiKey.slice(0, 8) + "..." : "(not set)"}`
    );

    // Claude Agent SDK 的 options.env 会替换整个子进程环境，而不是和
    // process.env 合并。继承本机系统环境，但剔除 AGEWORK_PRIVATE_* / AGEWORK_WORKER_*；
    // 系统环境模式额外保留 Claude 认证变量。
    const npmCacheDir = join(tmpdir(), "npm-cache-agent-runtime");
    const baseEnv: Record<string, string | undefined> = {
      ...pickSafeEnv(isEnvironmentConfig),
      NPM_CONFIG_CACHE: npmCacheDir,
    };

    // 自定义配置时注入认证信息
    const authEnv = isEnvironmentConfig
      ? {}
      : {
          ...(opts.baseUrl ? { ANTHROPIC_BASE_URL: opts.baseUrl } : {}),
          ...(opts.apiKey ? { ANTHROPIC_AUTH_TOKEN: opts.apiKey } : {}),
          ...(opts.model ? { ANTHROPIC_MODEL: opts.model } : {}),
          ...opts.extraConfig,
        };

    const isRoot = process.getuid?.() === 0;

    super({
      model: opts.model,
      // 系统环境时不限制 settingSources，让 SDK 从 ~/.claude.json 等文件读取认证。
      // 自定义配置时加载 project + local 级（cwd 下的 .claude/：skills、commands、CLAUDE.md、
      // settings 及本地覆盖 settings.local.json），不读本机 user 级 ~/.claude，认证仍通过 env 注入。
      // project 级必须加载，否则工作空间的 .claude/skills、.claude/commands 不会注册，
      // /<command> 会报 Unknown command。
      settingSources: isEnvironmentConfig ? undefined : ["project", "local"],
      permissionMode: "acceptEdits",
      ...(!isRoot ? { allowDangerouslySkipPermissions: true } : {}),
      env: { ...baseEnv, ...authEnv },
      cwd: workdir,
      ...(opts.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable }
        : {}),
      ...(workdir && {
        sandbox: { enabled: true, failIfUnavailable: false },
      }),
    });
    this.trace = trace;
    this.pendingActionSink = pendingActionSink;
  }

  private emitPendingAction(
    threadId: string,
    pendingAction: AgentPendingAction
  ) {
    const previous =
      this.pendingActionUpdates.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() =>
        Promise.resolve(this.pendingActionSink?.({ threadId, pendingAction }))
      )
      .catch((error) => {
        logger.warn(`pending action update failed: ${String(error)}`);
      })
      .finally(() => {
        if (this.pendingActionUpdates.get(threadId) === next) {
          this.pendingActionUpdates.delete(threadId);
        }
      });
    this.pendingActionUpdates.set(threadId, next);
  }

  protected override extraQueryOptions(
    input: ClaudeRunInput,
    _options: Options,
    subscriber: Subscriber<ProcessedEvent>
  ): Partial<Options> {
    const threadId = input.threadId ?? "default";
    const runId = typeof input.runId === "string" ? input.runId : undefined;
    // 新一轮 run 开始,清掉上一轮遗留的续接 runId 归属。
    this.resumedRunIds.delete(threadId);

    return {
      ...claudeThinkingOption(input),
      canUseTool: async (
        toolName: string,
        toolInput: Record<string, unknown>,
        opts: {
          signal: AbortSignal;
          suggestions?: PermissionUpdate[];
          blockedPath?: string;
          decisionReason?: string;
          toolUseID?: string;
          agentID?: string;
          title?: string;
          displayName?: string;
          description?: string;
        }
      ): Promise<PermissionResult> => {
        if (toolName !== "AskUserQuestion") {
          return this.requestToolPermission({
            threadId,
            runId,
            toolName,
            toolInput,
            options: opts,
            subscriber,
          });
        }
        // AskUserQuestion 与权限请求共用同一条 per-thread 串行队列:terminal
        // model 下一次只能有一个 open interrupt(一个 RUN_FINISHED 只发一次),
        // 排队保证"答完一个才出下一个",并消除并行 tool use 下问题被
        // supersede 静默覆盖的竞争。
        return this.enqueueControlRequest(threadId, () =>
          this.executeAskUserQuestion({
            threadId,
            runId,
            toolInput,
            options: opts,
            subscriber,
          })
        );
      },
    };
  }

  private executeAskUserQuestion(input: {
    threadId: string;
    runId?: string;
    toolInput: Record<string, unknown>;
    options: { signal: AbortSignal; toolUseID?: string };
    subscriber: unknown;
  }): Promise<PermissionResult> {
    const { threadId, runId, toolInput, options, subscriber } = input;

    // 排队期间 run 可能已被 abort,直接拒绝。
    if (options.signal.aborted) {
      return Promise.reject(new Error("Aborted"));
    }

    const eventSink = subscriber as { next(event: unknown): void };

    // Supersede any existing pending question for this thread(串行队列下
    // 正常不可达,留作安全网)。
    const existing = pendingQuestions.get(threadId);
    if (existing) {
      pendingQuestions.delete(threadId);
      existing.rejectWithoutCleanup(new Error("Superseded by new question"));
    }
    return new Promise<PermissionResult>((resolve, reject) => {
      const resolvePending = (result: PermissionResult) => {
        this.emitPendingAction(threadId, null);
        resolve(result);
      };
      const rejectPending = (error: Error) => {
        this.emitPendingAction(threadId, null);
        reject(error);
      };
      const questions = (toolInput.questions as unknown[]) ?? [];
      const interruptId = generateId();
      const pending: PendingQuestion = {
        questions,
        interruptId,
        resolveAnswers: (answers) =>
          resolvePending({
            behavior: "allow",
            updatedInput: { questions: toolInput.questions, answers },
          }),
        reject: rejectPending,
        rejectWithoutCleanup: reject,
        onResume: this.makeResumeStarter(eventSink, threadId),
      };
      pendingQuestions.set(threadId, pending);
      // 先发 interrupt 终止事件再置 pendingAction:两者走同一条上行通道,
      // FIFO 保证 server 聚合器先吃到 interrupts,requires_action 触发的
      // 局部保存才会带上 interrupts metadata。
      this.emitInterruptFinish(eventSink, {
        threadId,
        runId,
        interrupt: {
          id: interruptId,
          reason: "input_required",
          message: firstQuestionText(questions),
          ...(options.toolUseID ? { toolCallId: options.toolUseID } : {}),
          metadata: { questions },
        },
      });
      this.emitPendingAction(threadId, "question");
      options.signal.addEventListener(
        "abort",
        () => {
          if (pendingQuestions.get(threadId) === pending) {
            pendingQuestions.delete(threadId);
            rejectPending(new Error("Aborted"));
          } else {
            reject(new Error("Aborted"));
          }
        },
        { once: true }
      );
    });
  }

  /**
   * 发出 terminal-model 的中断收尾:RUN_FINISHED 携带 interrupt outcome,
   * 结束当前 AG-UI run。runId 取续接后的最新值(同一 SDK stream 内第二个
   * 问题属于续接 run,不能再用最初的 runId)。
   */
  private emitInterruptFinish(
    eventSink: { next(event: unknown): void },
    input: {
      threadId: string;
      runId?: string;
      interrupt: {
        id: string;
        reason: string;
        message?: string;
        toolCallId?: string;
        metadata?: Record<string, unknown>;
      };
    }
  ): void {
    const effectiveRunId =
      this.resumedRunIds.get(input.threadId) ?? input.runId;
    eventSink.next({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      ...(effectiveRunId ? { runId: effectiveRunId } : {}),
      outcome: { type: "interrupt", interrupts: [input.interrupt] },
    });
  }

  /** 答复携带 resumeRunId 时:记录归属并发出续接 RUN_STARTED。 */
  private makeResumeStarter(
    eventSink: { next(event: unknown): void },
    threadId: string
  ): (resumeRunId: string) => void {
    return (resumeRunId) => {
      this.resumedRunIds.set(threadId, resumeRunId);
      eventSink.next({
        type: EventType.RUN_STARTED,
        threadId,
        runId: resumeRunId,
      });
    };
  }

  /** 同一 SDK stream 的收尾事件归属续接 run(如有)。 */
  protected override finishRunId(threadId: string, runId: string): string {
    const resumed = this.resumedRunIds.get(threadId);
    this.resumedRunIds.delete(threadId);
    return resumed ?? runId;
  }

  protected override onBeforeQuery(
    prompt: string,
    options: Options,
    input: ClaudeRunInput
  ): void {
    const threadId = input.threadId ?? "default";
    const runId = typeof input.runId === "string" ? input.runId : undefined;
    this.emitTrace(
      "sdk.claude.input",
      { method: "query", arguments: { prompt, options } },
      { runId, threadId }
    );
  }

  protected override wrapMessageStream(
    stream: AsyncIterable<unknown>,
    input: ClaudeRunInput
  ): AsyncIterable<unknown> {
    const threadId = input.threadId ?? "default";
    const runId = typeof input.runId === "string" ? input.runId : undefined;
    return traceAsyncIterable(stream, (message) => {
      this.emitTrace("sdk.claude.output", message, { runId, threadId });
    });
  }

  protected override onStreamError(
    error: unknown,
    input: ClaudeRunInput
  ): void {
    const threadId = input.threadId ?? "default";
    const runId = typeof input.runId === "string" ? input.runId : undefined;
    this.emitTrace("sdk.claude.error", error, { runId, threadId });
  }

  private requestToolPermission(input: {
    threadId: string;
    runId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
      // 被拦截工具的 tool_use ID。不作为 AskUserQuestion 的 toolCallId 使用
      // （会导致同 ID 重复 TOOL_CALL_START，见下方说明），保留供未来审计/日志。
      toolUseID?: string;
    };
    subscriber: unknown;
  }): Promise<PermissionResult> {
    return this.enqueueControlRequest(input.threadId, () =>
      this.executePermissionRequest(input)
    );
  }

  /**
   * 串行化：per-thread 排队。前一个控制请求(权限或 AskUserQuestion)
   * resolve/reject 后才处理下一个，这样用户视角永远是单个待答卡片，答完一个
   * 才出下一个（对齐 Claude Code CLI），terminal model 下也保证一次只有一个
   * open interrupt。前一个失败（deny/abort）不应阻塞后一个，所以用 .catch 吞掉。
   */
  private enqueueControlRequest(
    threadId: string,
    task: () => Promise<PermissionResult>
  ): Promise<PermissionResult> {
    const prev = permissionQueues.get(threadId) ?? Promise.resolve();
    const current = prev.catch(() => {}).then(task);
    permissionQueues.set(threadId, current);
    // cleanup 链单独 catch，避免 current 的 rejection 经 finally 派生出
    // 无人 catch 的 rejected promise（Unhandled Rejection）。
    current
      .catch(() => {})
      .finally(() => {
        if (permissionQueues.get(threadId) === current) {
          permissionQueues.delete(threadId);
        }
      });
    return current as Promise<PermissionResult>;
  }

  private executePermissionRequest(input: {
    threadId: string;
    runId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
      toolUseID?: string;
    };
    subscriber: unknown;
  }): Promise<PermissionResult> {
    const {
      threadId,
      runId,
      toolName,
      toolInput,
      options,
      subscriber,
    } = input;

    // 排队期间 run 可能已被 abort，直接拒绝，避免发出无意义的 AskUserQuestion。
    if (options.signal.aborted) {
      return Promise.reject(new Error("Aborted"));
    }

    const suggestions = options.suggestions ?? [];
    const canAlwaysAllow = suggestions.some(
      (s) => s.destination === "localSettings"
    );
    const question = buildToolPermissionQuestion({
      toolName,
      toolInput,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      canAlwaysAllow,
    });
    const questions = [question];
    // 仅保留会被 SDK 写盘持久化的 localSettings 规则；其它 destination 不持久化，丢弃。
    const persistableSuggestions = suggestions.filter(
      (s) => s.destination === "localSettings"
    );
    // 这条 AskUserPermission 必须用独立的 toolCallId。被拦截工具的 TOOL_CALL_START
    // 已在 SDK 的 content_block_start 阶段发出且尚未 END，若复用其 toolUseID
    // 会导致同 ID 二次 START，触发 @ag-ui/client 的 EventEmitter 状态校验错误：
    // "A tool call with ID '...' is already in progress. Complete it with
    // 'TOOL_CALL_END' first." 前端按 toolName 渲染、后端按 threadId 的
    // pendingQuestions Map 关联答案，均不依赖此 ID 与原 tool-call 的关联。
    const toolCallId = generateId();
    const eventSink = subscriber as {
      next(event: unknown): void;
    };
    const argsText = JSON.stringify({ questions });
    // 同一 SDK stream 内第二个及之后的控制请求发生在续接 run 里,事件要归属
    // 最新的 AG-UI runId(cleanup 在答复续接之后触发,必须现算)。
    const currentRunId = () => this.resumedRunIds.get(threadId) ?? runId;

    eventSink.next({
      type: EventType.TOOL_CALL_START,
      threadId,
      ...(currentRunId() ? { runId: currentRunId() } : {}),
      toolCallId,
      toolCallName: "AskUserPermission",
    });
    eventSink.next({
      type: EventType.TOOL_CALL_ARGS,
      threadId,
      ...(currentRunId() ? { runId: currentRunId() } : {}),
      toolCallId,
      delta: argsText,
    });

    return new Promise<PermissionResult>((resolve, reject) => {
      // 这条合成工具调用没有真实的 SDK tool_use，不会像模型自己调用的
      // AskUserQuestion 那样从 SDK 的 tool_result 自动转出 TOOL_CALL_RESULT——
      // 必须在这里手动补发，否则 part.result 永远是 undefined，
      // ToolCallMessagePart 的 status 永远跟着所在消息走（见 assistant-ui
      // message-runtime 的 toMessagePartStatus），在 resume 重连等"这条仍是
      // 最后一条消息且 run 仍在跑"的窗口期会被重新判定成"运行中"，
      // 已经回答过的请求又变回待处理（"幽灵卡片"）。
      const cleanup = (resultContent: string) => {
        this.emitPendingAction(threadId, null);
        eventSink.next({
          type: EventType.TOOL_CALL_RESULT,
          threadId,
          ...(currentRunId() ? { runId: currentRunId() } : {}),
          messageId: `${toolCallId}-result`,
          toolCallId,
          content: resultContent,
          role: "tool",
        });
        eventSink.next({
          type: EventType.TOOL_CALL_END,
          threadId,
          ...(currentRunId() ? { runId: currentRunId() } : {}),
          toolCallId,
        });
      };
      const resolvePending = (result: PermissionResult, resultContent: string) => {
        cleanup(resultContent);
        resolve(result);
      };
      const rejectPending = (error: Error) => {
        cleanup(error.message);
        reject(error);
      };

      const interruptId = generateId();
      const pending: PendingQuestion = {
        questions,
        interruptId,
        onResume: this.makeResumeStarter(eventSink, threadId),
        resolveAnswers: (answers) => {
          const answer = answers[question.question];
          const value = Array.isArray(answer) ? answer[0] : answer;
          if (value === PERMISSION_ALWAYS_ALLOW_LABEL && persistableSuggestions.length > 0) {
            resolvePending({
              behavior: "allow",
              updatedInput: toolInput,
              updatedPermissions: persistableSuggestions,
            }, value);
            return;
          }
          if (value === TOOL_PERMISSION_ALLOW_LABEL) {
            resolvePending({ behavior: "allow", updatedInput: toolInput }, value);
            return;
          }
          resolvePending({
            behavior: "deny",
            message: "用户拒绝了该工具请求。",
          }, typeof value === "string" ? value : TOOL_PERMISSION_DENY_LABEL);
        },
        reject: rejectPending,
        rejectWithoutCleanup: reject,
      };
      // 顶替该 thread 上已存在的待答问题（与 canUseTool 里 AskUserQuestion
      // 分支的处理对齐）——否则并行触发的 AskUserQuestion 会被静默覆盖，其
      // promise 永远不会 resolve/reject，问题在 UI 上变得无法回答。
      const existing = pendingQuestions.get(threadId);
      if (existing) {
        pendingQuestions.delete(threadId);
        existing.rejectWithoutCleanup(new Error("Superseded by new question"));
      }
      pendingQuestions.set(threadId, pending);

      // 先发 interrupt 收尾再置 pendingAction(同通道 FIFO,保证 server
      // 局部保存时 interrupts 已在聚合器里)。
      this.emitInterruptFinish(eventSink, {
        threadId,
        runId,
        interrupt: {
          id: interruptId,
          reason: "tool_call",
          message: question.question,
          toolCallId,
          metadata: { questions },
        },
      });
      this.emitPendingAction(threadId, "question");

      options.signal.addEventListener(
        "abort",
        () => {
          if (pendingQuestions.get(threadId) === pending) {
            pendingQuestions.delete(threadId);
            rejectPending(new Error("Aborted"));
          } else {
            reject(new Error("Aborted"));
          }
        },
        { once: true }
      );
    });
  }

  private emitTrace(
    name: string,
    payload: unknown,
    context: { runId?: string; threadId: string }
  ): void {
    try {
      this.trace?.({
        name,
        payload,
        ...(context.runId ? { runId: context.runId } : {}),
        threadId: context.threadId,
      });
    } catch {
      // Tracing must never affect the agent stream.
    }
  }
}

export const PERMISSION_ALWAYS_ALLOW_LABEL = "始终允许";
const TOOL_PERMISSION_ALLOW_LABEL = "允许";
const TOOL_PERMISSION_DENY_LABEL = "拒绝";

function buildToolPermissionQuestion(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  canAlwaysAllow: boolean;
}) {
  const title =
    input.title ??
    `允许 Claude 使用 ${input.displayName ?? input.toolName}？`;
  const details = [
    input.description,
    input.decisionReason ? `原因：${input.decisionReason}` : undefined,
    input.blockedPath ? `路径：${input.blockedPath}` : undefined,
    input.description ? undefined : summarizeToolInput(input.toolInput),
  ]
    .filter(Boolean)
    .join("\n");

  const options: Array<{ label: string; description: string }> = [];
  if (input.canAlwaysAllow) {
    options.push({
      label: PERMISSION_ALWAYS_ALLOW_LABEL,
      description: "本次及后续同类工具调用均自动放行（写入 workspace 设置）。",
    });
  }
  options.push({
    label: TOOL_PERMISSION_ALLOW_LABEL,
    description: details || "允许本次工具调用继续执行。",
  });
  options.push({
    label: TOOL_PERMISSION_DENY_LABEL,
    description: "拒绝本次工具调用。",
  });

  return {
    question: title,
    header: "权限请求",
    options,
  };
}

/** 取第一个问题的文本作为 interrupt.message(可读提示,非结构化数据源)。 */
function firstQuestionText(questions: unknown[]): string | undefined {
  const first = questions[0];
  if (!first || typeof first !== "object") return undefined;
  const text = (first as Record<string, unknown>).question;
  return typeof text === "string" && text ? text : undefined;
}

function summarizeToolInput(input: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(input);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return "";
  }
}

function claudeThinkingOption(input: ClaudeRunInput): {
  thinking?: ThinkingConfig;
} {
  const forwardedProps = input.forwardedProps;
  if (!forwardedProps || typeof forwardedProps !== "object") return {};

  const mode = (forwardedProps as Record<string, unknown>).claudeThinkingMode;
  if (mode === "disabled") return { thinking: { type: "disabled" } };
  if (mode === "adaptive") return { thinking: { type: "adaptive" } };
  return {};
}

async function* traceAsyncIterable<T>(
  iterable: AsyncIterable<T>,
  trace: (value: T) => void
): AsyncGenerator<T> {
  for await (const value of iterable) {
    trace(value);
    yield value;
  }
}
