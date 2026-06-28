import { Injectable } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";

type ConversationListOptions = {
  status: string;
  sortKey: "createdAt" | "updatedAt";
  after?: string;
  take: number;
};

type MessageUpsertInput = {
  id: string;
  runId?: string;
  parent_id: string | null;
  format: string;
  content: unknown;
};

/**
 * Conversation 领域持久化边界：封装 conversation / message 的 Prisma 访问与事务。
 * 属主范围统一通过 workspace 关系过滤；删除守卫所需的 workspace 归属读取在此集中，
 * 避免 Service 注入 Prisma。
 */
@Injectable()
export class ConversationRepository {
  constructor(private prisma: PrismaService) {}

  findByOwner(userId: string, opts: ConversationListOptions) {
    return this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        workspace: this.ownerWhere(userId),
        status: opts.status,
      },
      orderBy: { [opts.sortKey]: "desc" },
      take: opts.take,
      ...(opts.after ? { cursor: { id: opts.after }, skip: 1 } : {}),
    });
  }

  findRegularByOwner(userId: string, take: number) {
    return this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        status: "regular",
        workspace: this.ownerWhere(userId),
      },
      orderBy: { updatedAt: "desc" },
      take,
    });
  }

  findMessagesForConversations(conversationIds: string[]) {
    return this.prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      orderBy: { createdAt: "asc" },
      select: { id: true, conversationId: true, content: true },
    });
  }

  findOwnedWorkspace(
    userId: string,
    workspaceId: string
  ): Promise<{ id: string } | null> {
    return this.prisma.workspace.findFirst({
      where: { id: workspaceId, ...this.ownerWhere(userId) },
      select: { id: true },
    });
  }

  create(data: {
    id: string;
    workspaceId: string;
    title?: string;
    agentType: string;
  }) {
    return this.prisma.conversation.create({ data });
  }

  findOwnedById(userId: string, conversationId: string) {
    return this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
    });
  }

  findRunStatusesByOwner(userId: string, ids: string[]) {
    return this.prisma.conversation.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      select: {
        id: true,
        activeRunStatus: true,
        pendingUserAction: true,
        updatedAt: true,
      },
    });
  }

  async setAgentSessionId(conversationId: string, agentSessionId: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { agentSessionId },
    });
  }

  findContentsByConversation(conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    });
  }

  findTitle(conversationId: string): Promise<{ title: string | null } | null> {
    return this.prisma.conversation.findUnique({
      where: { id: conversationId, deletedAt: null },
      select: { title: true },
    });
  }

  async updateTitle(conversationId: string, title: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { title },
    });
  }

  /** 仅改标题：用 raw SQL 避开 updatedAt 自动更新，避免会话重新排序；按属主限定。 */
  async renameOwned(userId: string, conversationId: string, title: string) {
    await this.prisma.$executeRaw`
      UPDATE Conversation
      SET title = ${title}
      WHERE id = ${conversationId}
        AND deletedAt IS NULL
        AND workspaceId IN (
          SELECT id FROM Workspace WHERE userId = ${userId} AND deletedAt IS NULL
        )
    `;
  }

  async updateOwned(
    userId: string,
    conversationId: string,
    data: { title?: string; status?: string }
  ) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      data,
    });
  }

  async setActiveRunStatus(
    conversationId: string,
    activeRunStatus: "idle" | "running" | "error"
  ): Promise<boolean> {
    const where =
      activeRunStatus === "running"
        ? { id: conversationId, activeRunStatus: { in: ["idle", "error"] } }
        : { id: conversationId };
    const result = await this.prisma.conversation.updateMany({
      where,
      data: { activeRunStatus, pendingUserAction: null },
    });
    return result.count > 0;
  }

  async setPendingUserAction(
    conversationId: string,
    pendingUserAction: string | null
  ) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { pendingUserAction },
    });
  }

  attachMessageToRun(conversationId: string, messageId: string, runId: string) {
    return this.prisma.message.updateMany({
      where: { id: messageId, conversationId },
      data: { runId },
    });
  }

  async archiveOwned(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      data: { status: "archived" },
    });
  }

  async unarchiveOwned(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      data: { status: "regular" },
    });
  }

  async softDeleteOwned(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      data: { deletedAt: new Date() },
    });
  }

  async clearArchivedOwned(userId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        status: "archived",
        deletedAt: null,
        workspace: this.ownerWhere(userId),
      },
      data: { deletedAt: new Date() },
    });
  }

  findMessages(conversationId: string) {
    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
  }

  async upsertMessage(conversationId: string, data: MessageUpsertInput) {
    const contentJson = this.toJsonInput(data.content);
    const parentId = await this.resolveParentId(
      conversationId,
      data.id,
      data.parent_id
    );
    await this.prisma.message.upsert({
      where: { id_conversationId: { id: data.id, conversationId } },
      create: {
        id: data.id,
        conversationId,
        runId: data.runId ?? null,
        parentId,
        format: data.format,
        content: contentJson,
      },
      update: {
        parentId,
        format: data.format,
        content: contentJson,
        ...(data.runId !== undefined ? { runId: data.runId } : {}),
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  private async resolveParentId(
    conversationId: string,
    messageId: string,
    parentId: string | null
  ) {
    if (parentId) return parentId;

    const existing = await this.prisma.message.findFirst({
      where: { id: messageId, conversationId },
      select: { parentId: true },
    });
    if (existing?.parentId) return existing.parentId;

    const previous = await this.prisma.message.findFirst({
      where: { conversationId, id: { not: messageId } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return previous?.id ?? null;
  }

  private toJsonInput(content: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(content ?? null)) as Prisma.InputJsonValue;
  }

  private ownerWhere(userId: string) {
    return { userId, deletedAt: null };
  }
}
