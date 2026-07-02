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

export type AgentOptionsByType = {
  claude: ClaudeAgentOptions;
  codex: CodexAgentOptions;
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
