import type { AgentType } from "../common";

export type AgentPermissionOption<T extends string = string> = {
  value: T;
  label: string;
  description: string;
};

export type ClaudePermissionMode =
  | "default"
  | "dontAsk"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

export type CodexApprovalPolicy =
  | "never"
  | "on-request"
  | "untrusted";

export type CodexSandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type CodexApprovalsReviewer = "user" | "auto_review";

export type CodexPermissionMode =
  | "default"
  | "auto-review"
  | "full-access";

export type ClaudeAgentOptions = {
  permissionMode: {
    defaultValue: ClaudePermissionMode;
    options: AgentPermissionOption<ClaudePermissionMode>[];
  };
};

export type CodexAgentOptions = {
  permissionMode: {
    defaultValue: CodexPermissionMode;
    options: Array<
      AgentPermissionOption<CodexPermissionMode> & {
        sandboxMode?: CodexSandboxMode;
        approvalPolicy?: CodexApprovalPolicy;
        approvalsReviewer?: CodexApprovalsReviewer;
        networkAccessEnabled?: boolean;
      }
    >;
  };
};

/** OpenCode 第一阶段无可配置权限模式；权限在运行时由 ACP options 提供。 */
export type OpenCodeAgentOptions = Record<string, never>;

/** Pi 同 OpenCode:无可配置权限模式,权限在运行时由 ACP options 提供。 */
export type PiAgentOptions = Record<string, never>;

export type AgentOptionsByType = {
  claude: ClaudeAgentOptions;
  codex: CodexAgentOptions;
  opencode: OpenCodeAgentOptions;
  pi: PiAgentOptions;
};

export type AgentOption = {
  [K in AgentType]: {
    id: K;
    label: string;
    options: AgentOptionsByType[K];
  };
}[AgentType];

export type AgentOptionsResponse = {
  list: AgentOption[];
};

/** 工作空间本地扫描出的 skill 条目，供 `/` 命令菜单使用。 */
export type SlashCommandItem = {
  name: string;
  description?: string;
};

export type AgentSkillsResponse = {
  list: SlashCommandItem[];
};
