import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { AgentType } from "@agework/shared";
import type {
  ConversationPendingUserAction,
  ConversationResponse,
  ConversationActiveRunStatus,
  ConversationSearchHit,
  ConversationSearchResponse,
  ConversationStatus,
} from "@agework/shared/api";
import type { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";
import { extractText } from "./message-text";
import { swallow } from "../common/swallow";

export type AssistantUserMessage = {
  id?: unknown;
  parentId?: unknown;
  parent_id?: unknown;
  content?: unknown;
};

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private prisma: PrismaService) {}

  private toConversationDto(c: {
    id: string;
    status: string;
    activeRunStatus: string;
    pendingUserAction?: string | null;
    title: string | null;
    workspaceId: string;
    agentType: string;
    agentSessionId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): ConversationResponse {
    return {
      conversationId: c.id,
      status: c.status as ConversationStatus,
      activeRunStatus: c.activeRunStatus as ConversationActiveRunStatus,
      pendingUserAction: this.normalizePendingUserAction(c.pendingUserAction),
      title: c.title ?? undefined,
      workspaceId: c.workspaceId,
      agentType: c.agentType as AgentType,
      ...(c.agentSessionId ? { agentSessionId: c.agentSessionId } : {}),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private normalizePendingUserAction(
    pendingUserAction: string | null | undefined
  ): ConversationPendingUserAction {
    return pendingUserAction === "question" ? "question" : null;
  }

  async list(userId: string, after?: string, status?: string, sort?: string) {
    const sortKey = sort === "createdAt" ? "createdAt" : "updatedAt";
    const conversations = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
        // 默认只返回常规会话；归档会话需显式 status=archived 查询
        status: status ?? "regular",
      },
      orderBy: { [sortKey]: "desc" },
      take: 50,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    return {
      list: conversations.map((c) => this.toConversationDto(c)),
    };
  }

  /**
   * 在当前用户的常规会话范围内做标题 + 消息正文匹配。
   * 用 LIKE 在 service 层做：消息 content 是 JSON，逐条 extractText 后字符串 includes。
   * 个人使用量级下足够；后续若需中文分词可升级为 SQLite FTS5。
   */
  async search(
    userId: string,
    query: string,
    limit = 20,
  ): Promise<ConversationSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) return { list: [] };

    const clampedLimit = Math.min(Math.max(1, limit), 50);
    const lowerQuery = trimmed.toLowerCase();

    // 1. 拉取当前用户全部常规会话（按 updatedAt desc，便于命中后保持顺序）
    const conversations = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        status: "regular",
        workspace: this.workspaceOwnerWhere(userId),
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });

    if (conversations.length === 0) return { list: [] };

    // 3. 先做标题匹配；标题命中的会话直接出结果，无需再扫描消息
    const hits: ConversationSearchHit[] = [];
    const unmatchedConversationIds: string[] = [];
    for (const c of conversations) {
      const title = c.title ?? "";
      const titleIdx = title.toLowerCase().indexOf(lowerQuery);
      if (titleIdx >= 0) {
        hits.push({
          conversation: this.toConversationDto(c),
          matchedField: "title",
          matchedSnippet: this.buildSnippet(title, titleIdx, trimmed.length),
        });
        if (hits.length >= clampedLimit) {
          return { list: hits.slice(0, clampedLimit) };
        }
      } else {
        unmatchedConversationIds.push(c.id);
      }
    }

    // 4. 对标题未命中的会话才 fetch messages（避免不必要的 IO）
    if (unmatchedConversationIds.length === 0) {
      return { list: hits.slice(0, clampedLimit) };
    }
    const messages = await this.prisma.message.findMany({
      where: { conversationId: { in: unmatchedConversationIds } },
      orderBy: { createdAt: "asc" },
      select: { id: true, conversationId: true, content: true },
    });
    const messagesByConversation = new Map<
      string,
      { id: string; conversationId: string; content: unknown }[]
    >();
    for (const m of messages) {
      const list = messagesByConversation.get(m.conversationId) ?? [];
      list.push(m);
      messagesByConversation.set(m.conversationId, list);
    }

    // 5. 按 conversations 的原顺序（updatedAt desc）扫描消息正文
    for (const c of conversations) {
      if (!unmatchedConversationIds.includes(c.id)) continue;

      const convMessages = messagesByConversation.get(c.id) ?? [];
      // 只看最近 200 条，避免超长对话内存压力
      const recentMessages = convMessages.slice(-200);
      for (const m of recentMessages) {
        const text = extractText(m.content).replace(/\s+/g, " ").trim();
        if (!text) continue;
        const idx = text.toLowerCase().indexOf(lowerQuery);
        if (idx >= 0) {
          hits.push({
            conversation: this.toConversationDto(c),
            matchedField: "message",
            matchedSnippet: this.buildSnippet(text, idx, trimmed.length),
          });
          break;
        }
      }

      if (hits.length >= clampedLimit) break;
    }

    return { list: hits.slice(0, clampedLimit) };
  }

  /** 在匹配位置周围截取片段，前后加省略号；长度上限约 100 字符。 */
  private buildSnippet(
    text: string,
    matchIndex: number,
    matchLength: number,
    radius = 40,
  ): string {
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + matchLength + radius);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end) + suffix;
  }

  async create(
    userId: string,
    workspaceId: string,
    firstMessage?: string,
    agentType?: string,
    title?: string,
  ) {
    if (!workspaceId) throw new BadRequestException("workspaceId is required");
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ...this.workspaceOwnerWhere(userId) },
    });
    if (!workspace)
      throw new BadRequestException(`Workspace ${workspaceId} not found`);
    const resolvedAgentType = this.resolveAgentType(agentType);
    const resolvedTitle =
      title ?? (firstMessage?.slice(0, 10) || undefined);
    const conversation = await this.prisma.conversation.create({
      data: {
        workspaceId,
        title: resolvedTitle,
        agentType: resolvedAgentType,
      },
    });
    return this.toConversationDto(conversation);
  }

  private resolveAgentType(agentType?: string): AgentType {
    const resolvedAgentType = agentType ?? "claude";
    if (resolvedAgentType !== "claude" && resolvedAgentType !== "codex") {
      throw new BadRequestException(
        `不支持的 agent 类型: ${resolvedAgentType}`
      );
    }
    return resolvedAgentType;
  }

  async findOne(userId: string, conversationId: string) {
    const c = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
    });
    if (!c) {
      throw new NotFoundException(`对话不存在: ${conversationId}`);
    }
    return this.toConversationDto(c);
  }

  async listRunStatuses(userId: string, ids: string[]) {
    const uniqueIds = [...new Set(ids.filter(Boolean))].slice(0, 50);
    if (uniqueIds.length === 0) return { list: [] };

    const conversations = await this.prisma.conversation.findMany({
      where: {
        id: { in: uniqueIds },
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      select: {
        id: true,
        activeRunStatus: true,
        pendingUserAction: true,
        updatedAt: true,
      },
    });

    return {
      list: conversations.map((conversation) => ({
        conversationId: conversation.id,
        activeRunStatus:
          conversation.activeRunStatus as ConversationActiveRunStatus,
        pendingUserAction: this.normalizePendingUserAction(
          conversation.pendingUserAction
        ),
        updatedAt: conversation.updatedAt.toISOString(),
      })),
    };
  }

  async getWorkspaceInfo(
    userId: string,
    conversationId: string
  ): Promise<{
    rootPath?: string;
    name?: string;
    runtimeType?: string;
    isolationScope?: string | null;
    sandboxEngine?: string | null;
  }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
    });
    if (!conversation) return {};
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: conversation.workspaceId, deletedAt: null },
      include: { directory: true },
    });
    return {
      rootPath: workspace?.directory?.rootPath,
      name: workspace?.name,
      runtimeType: workspace?.runtimeType ?? undefined,
      isolationScope: workspace?.isolationScope,
      sandboxEngine: workspace?.sandboxEngine,
    };
  }

  async setAgentSessionId(conversationId: string, agentSessionId: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { agentSessionId },
    });
  }

  async update(
    userId: string,
    conversationId: string,
    data: { title?: string; status?: string }
  ) {
    const { title, status } = data;

    // 只改标题时不更新 updatedAt，避免对话重新排序
    if (title !== undefined && status === undefined) {
      await this.prisma.$executeRaw`
        UPDATE Conversation
        SET title = ${title}
        WHERE id = ${conversationId}
          AND deletedAt IS NULL
          AND workspaceId IN (
            SELECT id FROM Workspace WHERE userId = ${userId} AND deletedAt IS NULL
          )
      `;
      return;
    }

    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      data: { title, status },
    });
  }

  async setActiveRunStatus(
    conversationId: string,
    activeRunStatus: "idle" | "running" | "error"
  ) {
    const where =
      activeRunStatus === "running"
        ? { id: conversationId, activeRunStatus: { in: ["idle", "error"] } }
        : { id: conversationId };
    return this.prisma.conversation.updateMany({
      where,
      data: { activeRunStatus, pendingUserAction: null },
    });
  }

  async setPendingUserAction(
    conversationId: string,
    pendingUserAction: ConversationPendingUserAction
  ) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { pendingUserAction },
    });
  }

  async saveUserMessage(
    conversationId: string,
    userMessage: AssistantUserMessage
  ) {
    const messageId =
      typeof userMessage.id === "string"
        ? userMessage.id
        : String(userMessage.id);
    const parentId =
      typeof userMessage.parentId === "string"
        ? userMessage.parentId
        : typeof userMessage.parent_id === "string"
          ? userMessage.parent_id
          : null;
    const content = userMessage.content;

    await this.upsertMessage(conversationId, {
      id: messageId,
      parent_id: parentId,
      format: "assistant-ui",
      content: {
        id: messageId,
        createdAt: new Date().toISOString(),
        role: "user",
        content: Array.isArray(content)
          ? content
          : [{ type: "text", text: this.messageText(content) }],
      },
    }).catch(
      swallow(
        this.logger,
        `save user message for conversation ${conversationId}`
      )
    );
    // 首条用户消息时自动生成标题（conversation 创建时不带 firstMessage）
    await this.ensureTitleFromMessage(conversationId, content).catch(
      swallow(this.logger, `generate title for conversation ${conversationId}`)
    );
  }

  async attachMessageToRun(
    conversationId: string,
    messageId: string,
    runId: string
  ) {
    return this.prisma.message.updateMany({
      where: { id: messageId, conversationId },
      data: { runId },
    });
  }

  private async ensureTitleFromMessage(
    conversationId: string,
    content: unknown
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId, deletedAt: null },
      select: { title: true },
    });
    if (conversation?.title) return;
    const text = extractText(content).replace(/\s+/g, " ").trim();
    if (!text) return;
    // 截断处理可能残留半截标点（逗号/句号/问号等），去掉结尾的标点和空白
    const title = text
      .slice(0, 40)
      .replace(
        /[，。、；！？,.;!?…—\-~·"'"'「」『』（）()【】[\]《》<>\s]+$/u,
        ""
      );
    if (!title) return;
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, deletedAt: null },
      data: { title },
    });
  }

  async archive(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      data: { status: "archived" },
    });
  }

  async unarchive(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      data: { status: "regular" },
    });
  }

  async delete(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      data: { deletedAt: new Date() },
    });
  }

  async clearArchived(userId: string) {
    await this.prisma.conversation.updateMany({
      where: {
        status: "archived",
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
      data: { deletedAt: new Date() },
    });
  }

  async listMessages(userId: string, conversationId: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        deletedAt: null,
        workspace: this.workspaceOwnerWhere(userId),
      },
    });
    if (!conversation) return [];

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    let previousMessageId: string | null = null;
    return messages.map((m) => {
      const content = m.content as unknown;
      const message = {
        id: m.id,
        parent_id: m.parentId ?? previousMessageId,
        format: this.normalizeMessageFormat(m.format, content),
        content,
      };
      previousMessageId = message.id;
      return message;
    });
  }

  async upsertMessage(
    conversationId: string,
    data: {
      id: string;
      runId?: string;
      parent_id: string | null;
      format: string;
      content: unknown;
    }
  ) {
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

  private normalizeMessageFormat(format: string, content: unknown) {
    if (
      typeof content === "object" &&
      content !== null &&
      "role" in content &&
      typeof (content as Record<string, unknown>).role === "string"
    ) {
      return "assistant-ui";
    }
    return format;
  }

  private toJsonInput(content: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(content ?? null)) as Prisma.InputJsonValue;
  }

  private messageText(content: unknown) {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    if (typeof content === "number" || typeof content === "boolean") {
      return String(content);
    }
    return "";
  }

  private workspaceOwnerWhere(userId: string) {
    return { userId, deletedAt: null };
  }
}
