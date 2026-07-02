import { createContext } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";

export const AgentChatRuntimeContext = createContext<AssistantRuntime | null>(null);
