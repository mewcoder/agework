import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RunUsage } from "@agework/shared/protocol";
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
    await this.assertConversationExists(data.conversationId);
    return this.prisma.run.create({
      data: {
        id: data.id,
        conversationId: data.conversationId,
        agentType: data.agentType,
        runtimeType: data.runtimeType,
      },
    });
  }

  private async assertConversationExists(conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: { deletedAt: null },
      },
      select: { id: true },
    });

    if (!conversation) {
      throw new BadRequestException("Conversation 不存在，不能创建 Run");
    }
  }

  async markRunning(runId: string) {
    await this.prisma.run.updateMany({
      where: { id: runId, status: { in: RUNNING_MUTABLE_STATUSES } },
      data: { status: "running", startedAt: new Date() },
    });
  }

  /** 持久化运行句柄，供孤儿恢复时定位 runtime provider 与底层进程/容器。 */
  async updateRuntimeHandle(
    runId: string,
    runtimeType: string,
    runtimeInstanceId: string
  ) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { runtimeType, runtimeInstanceId },
    });
  }

  async recordUsage(runId: string, usage: RunUsage) {
    await this.prisma.run.update({
      where: { id: runId },
      data: { usage: usage as unknown as Prisma.InputJsonValue },
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

  async findAllActive() {
    return this.prisma.run.findMany({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
    });
  }

  async listAdmin(params: { status?: string; take: number; skip: number }) {
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

    return {
      list: runs.map(({ conversation, ...run }) => ({
        ...run,
        userId: conversation.workspace.userId,
        workspaceId: conversation.workspaceId,
        username: conversation.workspace.user.username,
        conversationTitle: conversation.title,
        workspaceName: conversation.workspace.name,
      })),
      total,
      pageNo: skip / take + 1,
      pageSize: take,
    };
  }

  async detailAdmin(id: string) {
    const run = await this.prisma.run.findUnique({
      where: { id },
      include: {
        conversation: {
          select: {
            id: true,
            title: true,
            activeRunStatus: true,
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

    if (!run) {
      throw new NotFoundException(`Run ${id} 不存在`);
    }

    const runtimeInstanceRecord = run.runtimeInstanceId
      ? await this.prisma.runtimeInstance.findUnique({
          where: {
            runtimeType_runtimeInstanceId: {
              runtimeType: run.runtimeType,
              runtimeInstanceId: run.runtimeInstanceId,
            },
          },
          select: {
            id: true,
            runtimeType: true,
            isolationScope: true,
            ownerId: true,
            runtimeInstanceId: true,
            status: true,
            expiresAt: true,
            createdAt: true,
            updatedAt: true,
            workspaceRuntimeInstances: {
              select: {
                id: true,
                workspaceId: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        })
      : null;
    const runtimeInstance = runtimeInstanceRecord
      ? (() => {
          const { workspaceRuntimeInstances, ...resource } = runtimeInstanceRecord;
          return {
            ...resource,
            workspaceRuntimes: workspaceRuntimeInstances,
          };
        })()
      : null;

    const { conversation, ...runData } = run;
    const workspace = conversation.workspace;

    return {
      ...runData,
      userId: workspace.userId,
      workspaceId: conversation.workspaceId,
      username: workspace.user.username,
      conversationTitle: conversation.title,
      workspaceName: workspace.name,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        activeRunStatus: conversation.activeRunStatus,
        pendingUserAction: conversation.pendingUserAction,
        agentSessionId: conversation.agentSessionId,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
      },
      user: {
        id: workspace.user.id,
        username: workspace.user.username,
      },
      runtimeInstance,
    };
  }
}
