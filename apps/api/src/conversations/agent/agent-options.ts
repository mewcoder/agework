import { AGENT_LABELS, AGENT_TYPES } from "@agework/shared";
import type {
  AgentOption,
  AgentOptionsByType,
  AgentOptionsResponse,
} from "@agework/shared/api";

const CLAUDE_PERMISSION_OPTIONS = [
  {
    value: "default",
    label: "编辑前询问",
    description: "编辑或执行需要权限的操作前先询问",
  },
  {
    value: "acceptEdits",
    label: "自动编辑",
    description: "自动批准工作目录内的文件编辑和文件系统操作",
  },
  {
    value: "plan",
    label: "计划模式",
    description: "只读探索并提出方案，不编辑文件",
  },
  {
    value: "auto",
    label: "自动模式",
    description: "由 Claude 自动判断是否允许工具请求",
  },
  {
    value: "bypassPermissions",
    label: "完全访问",
    description: "绕过权限检查，自动批准所有工具请求",
  },
] as const;

export function isRootRuntime() {
  return process.getuid?.() === 0;
}

export function getAgentOptionsByType(): AgentOptionsByType {
  const isRoot = isRootRuntime();
  return {
    claude: {
      permissionMode: {
        defaultValue: "acceptEdits",
        options: CLAUDE_PERMISSION_OPTIONS.filter(
          (option) => !isRoot || option.value !== "bypassPermissions"
        ),
      },
    },
    codex: {
      permissionMode: {
        defaultValue: "auto-review",
        options: [
          {
            value: "default",
            label: "请求批准",
            description: "编辑外部文件和使用互联网时始终询问",
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            networkAccessEnabled: false,
          },
          {
            value: "auto-review",
            label: "替我审批",
            description: "仅对检测到的风险操作请求批准",
            sandboxMode: "workspace-write",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            networkAccessEnabled: false,
          },
          {
            value: "full-access",
            label: "完全访问",
            description: "可不受限制地访问互联网和您电脑上的任何文件",
            sandboxMode: "danger-full-access",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            networkAccessEnabled: true,
          },
        ],
      },
    },
  };
}

export function getAgentOptions(): AgentOptionsResponse {
  const optionsByType = getAgentOptionsByType();
  return {
    agents: AGENT_TYPES.map(
      (id) =>
        ({
          id,
          label: AGENT_LABELS[id],
          options: optionsByType[id],
        }) as AgentOption
    ),
  };
}
