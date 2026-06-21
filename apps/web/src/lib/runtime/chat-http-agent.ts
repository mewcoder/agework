import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { useAuthStore } from "@/stores/auth-store";

// token 不写入初始化 headers，而是在 requestInit 覆写中每次动态读取，
// 确保 auth store token 更新后（如改密重新登录）后续请求使用新 token
export class ChatHttpAgent extends HttpAgent {
  protected requestInit(input: RunAgentInput): RequestInit {
    const init = super.requestInit(input);
    const token = useAuthStore.getState().token;
    if (!token) return init;
    return {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: `Bearer ${token}`,
      },
    };
  }
}
