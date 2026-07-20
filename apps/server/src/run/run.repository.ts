import { Injectable } from "@nestjs/common";
import type { AgentContextUsage, RunUsage } from "@agework/shared/protocol";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";
import {
  ACTIVE_RUN_STATUSES,
  RUNNING_MUTABLE_STATUSES,
} from "./status/run-status.policy";

@Injectable()
export class RunRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    id: string;
    conversationId: string;
    agentType: string;
    runtimeType: string;
  }) {
    // conversation 存在性/归属由上游 RunLauncher.claimRun 经 conversation port 守卫。
    return this.prisma.run.create({
      data: {
        id: data.id,
        conversationId: data.conversationId,
        agentType: data.agentType,
        runtimeType: data.runtimeType,
      },
    });
  }

  async markRunning(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: RUNNING_MUTABLE_STATUSES } },
      data: { status: "running", startedAt: new Date() },
    });
  }

  async recordUsage(runId: string, usage: RunUsage) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { usage: usage as unknown as Prisma.InputJsonValue },
    });
  }

  async recordContextUsage(runId: string, contextUsage: AgentContextUsage) {
    await this.prisma.run.update({
      where: { id: runId },
      data: {
        contextUsage: contextUsage as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async markCancelling(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: "cancelling" },
    });
  }

  async markFinished(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: "finished", finishedAt: new Date() },
    });
  }

  async markError(runId: string, error: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: "error", error, finishedAt: new Date() },
    });
  }

  async markCancelled(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: ACTIVE_RUN_STATUSES } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  }

  async markRequiresAction(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: RUNNING_MUTABLE_STATUSES } },
      data: { status: "requires_action" },
    });
  }

  async findActiveByConversationId(conversationId: string) {
    return this.prisma.run.findFirst({
      where: { conversationId, status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
  }

  async listActive() {
    return this.prisma.run.findMany({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
      // 恢复路径需要知道 run 落在哪台 Host 上，以便判死后清理远端会话。
      include: {
        conversation: {
          select: {
            workspace: { select: { runtimeHostId: true } },
          },
        },
      },
    });
  }

  /**
   * 查找仍投影为 running、但已经没有活跃 Run 的会话。用于重启后修复
   * Run 终态已落库而 Conversation 投影未落库的崩溃窗口。
   */
  async findRunningConversationsWithoutActiveRun() {
    return this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        runStatus: "running",
        runs: { none: { status: { in: ACTIVE_RUN_STATUSES } } },
      },
      select: {
        id: true,
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { status: true },
        },
      },
    });
  }

  /** Host 重连对账：批量读取其现场 run 的数据库状态与取消命令所需会话 id。 */
  async findRuntimeReconciliationRows(runIds: string[]) {
    if (runIds.length === 0) return [];
    return this.prisma.run.findMany({
      where: { id: { in: runIds } },
      select: { id: true, conversationId: true, status: true },
    });
  }

  /** workspace 删除级联用：该 workspace 下所有活跃 run 的会话 id（去重）。 */
  async findActiveConversationIdsForWorkspace(
    workspaceId: string
  ): Promise<string[]> {
    const rows = await this.prisma.run.findMany({
      where: {
        conversation: { workspaceId },
        status: { in: ACTIVE_RUN_STATUSES },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    return rows.map((row) => row.conversationId);
  }

  /** user 停用/删除级联用：该 user 名下所有活跃 run 的会话 id（去重）。 */
  async findActiveConversationIdsForUser(
    userId: string
  ): Promise<string[]> {
    const rows = await this.prisma.run.findMany({
      where: {
        conversation: { workspace: { userId } },
        status: { in: ACTIVE_RUN_STATUSES },
      },
      select: { conversationId: true },
      distinct: ["conversationId"],
    });
    return rows.map((row) => row.conversationId);
  }

  /** 管理端：按 runId 查 conversationId（用于定位该 run 对应的 raw trace 文件）。 */
  async findConversationId(runId: string): Promise<string | null> {
    const run = await this.prisma.run.findUnique({
      where: { id: runId },
      select: { conversationId: true },
    });
    return run?.conversationId ?? null;
  }

  /** 管理端列表:按 status 过滤 + 分页,带 owner 上下文 join。响应塑形归 RunService。 */
  async listForAdmin(params: { status?: string; take: number; skip: number }) {
    const { status, take, skip } = params;
    const where = status ? { status } : undefined;

    const [runs, total] = await Promise.all([
      this.prisma.run.findMany({
        where,
        include: {
          conversation: {
            select: {
              title: true,
              workspaceId: true,
              workspace: {
                select: {
                  name: true,
                  userId: true,
                  user: { select: { username: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.run.count({ where }),
    ]);

    return { runs, total };
  }

  /** 管理端详情:按 id 查带 owner 上下文的 run 行(可空,不抛异常;非空守卫与响应塑形归 Service)。 */
  findAdminDetail(id: string) {
    return this.prisma.run.findUnique({
      where: { id },
      include: {
        conversation: {
          select: {
            id: true,
            title: true,
            runStatus: true,
            pendingUserAction: true,
            agentSessionId: true,
            workspaceId: true,
            workspace: {
              select: {
                id: true,
                name: true,
                userId: true,
                user: { select: { id: true, username: true } },
              },
            },
          },
        },
      },
    });
  }
}
