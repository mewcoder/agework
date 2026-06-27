import type { Subscription } from "rxjs";
import type { AgentType } from "@agework/shared";
import type { CommandPayload } from "@agework/shared/protocol";
import type { AgentDriver, AgentRunInput } from "./agent-driver.js";

type StatusPayload =
  | { status: "finished" }
  | { status: "error"; error: string }
  | { status: "cancelled" };

type ActiveRun = { agentType: AgentType; aguiThreadId: string; sub: Subscription };
type StatusReporter = (
  runId: string,
  payload: StatusPayload
) => void | Promise<void>;

/**
 * Persistent worker 内按 agentType 路由的多 run 路由器。
 *
 * 同一 workspace 下的持久容器会承接多个会话，这些会话可能分属不同 agentType
 * （claude / codex）。每个 agentType 拥有独立的 driver 实例（注入各自的
 * apiKey/model/baseUrl），run/cancel 按 runId 关联的 agentType 路由到正确
 * driver，避免跨 agentType 复用单例 driver 导致配置串台。
 */
export class RunRouter {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly cancelled = new Set<string>();
  private readonly terminalOverrides = new Map<string, StatusPayload>();
  private readonly terminalReports = new Map<string, Promise<void>>();
  private readonly drivers = new Map<AgentType, AgentDriver>();

  constructor(
    private readonly emit: (runId: string, event: unknown) => void,
    private readonly reportStatus: StatusReporter
  ) {}

  /** 注册某 agentType 的 driver。首个该 agentType 的 run 到达前必须注册。 */
  setDriver(agentType: AgentType, driver: AgentDriver): void {
    this.drivers.set(agentType, driver);
  }

  startRun(
    runId: string,
    agentType: AgentType,
    input: AgentRunInput
  ): void {
    if (this.runs.has(runId)) return; // 去重
    const driver = this.drivers.get(agentType);
    if (!driver) {
      // 不应发生：main 在 startRun 前已 ensureDriver。守卫以防遗漏。
      this.reportStatus(runId, {
        status: "error",
        error: `no driver registered for agentType ${agentType}`,
      });
      return;
    }
    const aguiThreadId = input.aguiThreadId;
    const sub = driver.run(input).subscribe({
      next: (event) => this.emit(runId, event),
      complete: () => {
        this.finishRun(runId, { status: "finished" });
      },
      error: (err: Error) => {
        this.finishRun(runId, { status: "error", error: err.message });
      },
    });
    this.runs.set(runId, { agentType, aguiThreadId, sub });
  }

  async cancelRun(runId: string, _aguiThreadId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;

    this.cancelled.add(runId);
    // 以 run 记录的 threadId 为准，避免过期 command 携带的 threadId 误伤新 run。
    await this.drivers.get(run.agentType)?.cancel(run.aguiThreadId);
    return true;
  }

  async interruptRun(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;

    await this.drivers.get(run.agentType)?.interrupt(run.aguiThreadId);
    return true;
  }

  async resolveControl(
    runId: string,
    command: CommandPayload
  ): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;

    const driver = this.drivers.get(run.agentType);
    if (!driver) return false;
    return Boolean(await driver.resolveControl(command));
  }

  activeRuns(): Array<{ runId: string; agentType: AgentType; aguiThreadId: string }> {
    return [...this.runs.entries()].map(([runId, run]) => ({
      runId,
      agentType: run.agentType,
      aguiThreadId: run.aguiThreadId,
    }));
  }

  async shutdownAll(payload: StatusPayload): Promise<void> {
    const entries = [...this.runs.entries()];
    const pendingReports: Promise<void>[] = [];
    for (const [runId] of entries) {
      this.terminalOverrides.set(runId, payload);
      pendingReports.push(
        this.terminalReports.get(runId) ??
          this.startTerminalReport(runId, payload)
      );
    }

    const pendingCancels: Promise<void>[] = [];
    for (const [runId, run] of entries) {
      if (!this.runs.has(runId)) continue;
      run.sub.unsubscribe();
      pendingCancels.push(this.cancelActiveRun(run));
      this.drop(runId);
    }

    await Promise.allSettled([...pendingReports, ...pendingCancels]);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  size(): number {
    return this.runs.size;
  }

  private drop(runId: string): void {
    this.runs.delete(runId);
    this.cancelled.delete(runId);
    this.terminalOverrides.delete(runId);
  }

  private finishRun(runId: string, fallback: StatusPayload): void {
    const payload =
      this.terminalOverrides.get(runId) ??
      (this.cancelled.has(runId) ? { status: "cancelled" } : fallback);
    void this.startTerminalReport(runId, payload).catch(() => {});
    this.drop(runId);
  }

  private startTerminalReport(
    runId: string,
    payload: StatusPayload
  ): Promise<void> {
    const report = this.report(runId, payload);
    this.terminalReports.set(runId, report);
    report.then(
      () => {
        if (this.terminalReports.get(runId) === report) {
          this.terminalReports.delete(runId);
        }
      },
      () => {
        if (this.terminalReports.get(runId) === report) {
          this.terminalReports.delete(runId);
        }
      }
    );
    return report;
  }

  private report(runId: string, payload: StatusPayload): Promise<void> {
    try {
      return Promise.resolve(this.reportStatus(runId, payload));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private cancelActiveRun(run: ActiveRun): Promise<void> {
    try {
      return Promise.resolve(this.drivers.get(run.agentType)?.cancel(run.aguiThreadId));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
