import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import { createAssistantStream } from "assistant-stream";
import { conversationsApi, type Conversation } from "@/api/conversations";
import { useSelectionStore } from "@/stores/selection-store";
import { ThreadHistoryProvider } from "./thread-history-provider";

// conversation 的业务元数据透传到 RemoteThreadList 的 custom，供 runtimeHook / sidebar 读取
function toMetadata(c: Conversation) {
  return {
    status: (c.status === "archived" ? "archived" : "regular") as
      | "archived"
      | "regular",
    remoteId: c.conversationId,
    title: c.title,
    custom: {
      workspaceId: c.workspaceId,
      agentType: c.agentType,
      runStatus: c.runStatus,
      pendingUserAction: c.pendingUserAction,
    },
  };
}

let pendingInitializeTitle: string | undefined;

export function setPendingInitializeTitle(title: string | undefined) {
  pendingInitializeTitle = title;
}

export function clearPendingInitializeTitle() {
  pendingInitializeTitle = undefined;
}

export function createThreadListAdapter(
  onConversationArchived?: (conversationId: string) => void,
): RemoteThreadListAdapter {
  return {
    async list() {
      const { conversations } = await conversationsApi.list();
      // assistant-ui RemoteThreadListAdapter 要求返回 { threads } key
      return { threads: conversations.map(toMetadata) };
    },

    async initialize() {
      const { selectedWorkspaceId, selectedAgentType } = useSelectionStore.getState();
      if (!selectedWorkspaceId) {
        throw new Error("缺少工作空间，无法创建会话");
      }
      const title = pendingInitializeTitle;
      pendingInitializeTitle = undefined;
      const conversation = await conversationsApi.create({
        workspaceId: selectedWorkspaceId,
        agentType: selectedAgentType,
        title,
      });
      return { remoteId: conversation.conversationId, externalId: undefined };
    },

    async rename(remoteId, title) {
      await conversationsApi.rename(remoteId, title);
    },

    async archive(remoteId) {
      await conversationsApi.archive(remoteId);
      onConversationArchived?.(remoteId);
    },
    async unarchive(remoteId) {
      await conversationsApi.unarchive(remoteId);
    },

    async delete(remoteId) {
      await conversationsApi.delete(remoteId);
    },

    async fetch(remoteId) {
      const conversation = await conversationsApi.get(remoteId);
      return toMetadata(conversation);
    },

    // 框架的 generateTitle 结果只写入其内存 state、不持久化；本应用标题由后端
    // 在首条用户消息时生成（见 ConversationService.ensureTitleFromMessage），UI 标题
    // 来自 useConversations()。故此处返回空流即可。
    async generateTitle() {
      return createAssistantStream(() => {});
    },

    unstable_Provider: ThreadHistoryProvider,
  };
}
