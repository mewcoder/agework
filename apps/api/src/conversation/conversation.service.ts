import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { generateId, isAgentType, type AgentType } from "@agework/shared";
import type {
  ConversationPendingUserAction,
  ConversationResponse,
  ConversationActiveRunStatus,
  ConversationSearchHit,
  ConversationSearchResponse,
  ConversationStatus,
} from "@agework/shared/api";
import { swallow } from "../common/swallow";
import { ConversationRepository } from "./conversation.repository";
import { TitleService } from "./title/title.service";
import type { AssistantUserMessage } from "./conversation.types";

// 从 assistant-ui 消息 content(string / part 数组 / { role, content } 对象)提取纯文本。
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: string; text: string } =>
          !!p &&
          typeof p === "object" &&
          (p as { type?: unknown }).type === "text" &&
          typeof (p as { text?: unknown }).text === "string"
      )
      .map((p) => p.text)
      .join(" ");
  }
  // assistant-ui 消息：{ id, role, content: [...] }，递归提取其 content 字段
  if (content !== null && typeof content === "object" && "content" in content) {
    return extractText(content.content);
  }
  return "";
}

function isStoredUserMessage(
  content: unknown
): content is { role: "user"; content: unknown } {
  return (
    content !== null &&
    typeof content === "object" &&
    (content as { role?: unknown }).role === "user"
  );
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private repo: ConversationRepository,
    @Optional() private readonly titleService?: TitleService
  ) {}

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
    const conversations = await this.repo.findByOwner(userId, {
      // 默认只返回常规会话；归档会话需显式 status=archived 查询
      status: status ?? "regular",
      sortKey,
      after,
      take: 50,
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
    limit = 20
  ): Promise<ConversationSearchResponse> {
    const trimmed = query.trim();
    if (!trimmed) return { list: [] };

    const clampedLimit = Math.min(Math.max(1, limit), 50);
    const lowerQuery = trimmed.toLowerCase();

    // 1. 拉取当前用户全部常规会话（按 updatedAt desc，便于命中后保持顺序）
    const conversations = await this.repo.findRegularByOwner(userId, 200);

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
    const messages = await this.repo.findMessagesForConversations(
      unmatchedConversationIds
    );
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
    radius = 40
  ): string {
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + matchLength + radius);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end) + suffix;
  }

  /**
   * 创建会话数据。`workspaceId` 必须由调用方(agent 入口)预先校验归属;
   * 本方法只负责持久化,不读取 / 校验 workspace。
   */
  async create(
    workspaceId: string,
    firstMessage?: string,
    agentType?: string,
    title?: string
  ) {
    const resolvedAgentType = this.resolveAgentType(agentType);
    const resolvedTitle = title ?? (firstMessage?.slice(0, 10) || undefined);
    const conversation = await this.repo.create({
      id: generateId(),
      workspaceId,
      title: resolvedTitle,
      agentType: resolvedAgentType,
    });
    return this.toConversationDto(conversation);
  }

  private resolveAgentType(agentType?: string): AgentType {
    const resolvedAgentType = agentType ?? "claude";
    if (!isAgentType(resolvedAgentType)) {
      throw new BadRequestException(
        `不支持的 agent 类型: ${resolvedAgentType}`
      );
    }
    return resolvedAgentType;
  }

  async findOne(userId: string, conversationId: string) {
    const c = await this.repo.findOwnedById(userId, conversationId);
    if (!c) {
      throw new NotFoundException(`对话不存在: ${conversationId}`);
    }
    return this.toConversationDto(c);
  }

  async listRunStatuses(userId: string, ids: string[]) {
    const uniqueIds = [...new Set(ids.filter(Boolean))].slice(0, 50);
    if (uniqueIds.length === 0) return { list: [] };

    const conversations = await this.repo.findRunStatusesByOwner(
      userId,
      uniqueIds
    );

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

  async setAgentSessionId(conversationId: string, agentSessionId: string) {
    await this.repo.setAgentSessionId(conversationId, agentSessionId);
  }

  async generateTitleIfNeeded(input: {
    conversationId: string;
    agentType: AgentType;
    modelProviderId?: string | null;
  }): Promise<void> {
    if (!this.titleService) return;

    const userText = await this.findInitialUserText(input.conversationId);
    if (!userText) return;

    const title = await this.titleService.generateTitle({
      agentType: input.agentType,
      modelProviderId: input.modelProviderId,
      userText,
    });
    if (!title) return;

    await this.repo.updateTitle(input.conversationId, title);
  }

  async update(
    userId: string,
    conversationId: string,
    data: { title?: string; status?: string }
  ) {
    const { title, status } = data;

    // 只改标题时不更新 updatedAt，避免对话重新排序
    if (title !== undefined && status === undefined) {
      await this.repo.renameOwned(userId, conversationId, title);
      return;
    }

    await this.repo.updateOwned(userId, conversationId, { title, status });
  }

  async setActiveRunStatus(
    conversationId: string,
    activeRunStatus: "idle" | "running" | "error"
  ): Promise<boolean> {
    return this.repo.setActiveRunStatus(conversationId, activeRunStatus);
  }

  async setPendingUserAction(
    conversationId: string,
    pendingUserAction: ConversationPendingUserAction
  ) {
    await this.repo.setPendingUserAction(conversationId, pendingUserAction);
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
    return this.repo.attachMessageToRun(conversationId, messageId, runId);
  }

  private async ensureTitleFromMessage(
    conversationId: string,
    content: unknown
  ) {
    const conversation = await this.repo.findTitle(conversationId);
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
    await this.repo.updateTitle(conversationId, title);
  }

  private async findInitialUserText(
    conversationId: string
  ): Promise<string | null> {
    const messages = await this.repo.findContentsByConversation(conversationId);
    let userMessageCount = 0;
    let firstUserText: string | null = null;

    for (const m of messages) {
      if (!isStoredUserMessage(m.content)) continue;
      userMessageCount += 1;
      if (userMessageCount > 1) return null;

      const text = extractText(m.content.content).trim();
      firstUserText = text || null;
    }

    return firstUserText;
  }

  async archive(userId: string, conversationId: string) {
    await this.repo.archiveOwned(userId, conversationId);
  }

  async unarchive(userId: string, conversationId: string) {
    await this.repo.unarchiveOwned(userId, conversationId);
  }

  async delete(userId: string, conversationId: string) {
    await this.repo.softDeleteOwned(userId, conversationId);
  }

  /**
   * Workspace 删除后的会话级联软删入口。由 WorkspaceService 编排调用，
   * conversation 自己持有 conversation/message 持久化边界。
   */
  async softDeleteByWorkspace(workspaceId: string, deletedAt = new Date()) {
    await this.repo.softDeleteByWorkspace(workspaceId, deletedAt);
  }

  async clearArchived(userId: string) {
    await this.repo.clearArchivedOwned(userId);
  }

  async listMessages(userId: string, conversationId: string) {
    const conversation = await this.repo.findOwnedById(userId, conversationId);
    if (!conversation) return [];

    const messages = await this.repo.findMessages(conversationId);
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
    await this.repo.upsertMessage(conversationId, data);
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

  private messageText(content: unknown) {
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    if (typeof content === "number" || typeof content === "boolean") {
      return String(content);
    }
    return "";
  }
}
