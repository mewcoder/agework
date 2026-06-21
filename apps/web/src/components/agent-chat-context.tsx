import { createContext, useContext } from "react";
import type { AgentType } from "@/stores/selection-store";

interface AgentChatContextValue {
  onSelectConversation: (remoteId: string) => void;
  onNewConversation: (workspaceId?: string, agent?: AgentType) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onClearWorkspace: () => void;
}

export const AgentChatContext = createContext<AgentChatContextValue>({
  onSelectConversation: () => {},
  onNewConversation: () => {},
  onSelectWorkspace: () => {},
  onClearWorkspace: () => {},
});

export function useAgentChatContext() {
  return useContext(AgentChatContext);
}
