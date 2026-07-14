import { Badge } from "@/components/ui/badge";
import {
  SettingsSection,
  SettingsItem,
} from "@/components/settings/settings-section";
import { useRuntimes, type Runtime } from "@/hooks/use-runtime";
import type { AgentEnvStatus } from "@agework/shared/api";
import type { AgentType } from "@agework/shared";
import { formatDateTime } from "@/utils/format";

function runtimeTypeLabel(runtimeType: string | null) {
  switch (runtimeType) {
    case "native":
      return "本地";
    case "docker":
      return "Docker";
    case "opensandbox":
      return "OpenSandbox";
    default:
      return "待配对";
  }
}

// ── 只读 Agent CLI 行 ─────────────────────────────────────────────────

function ReadOnlyAgentItem({
  agentType,
  status,
}: {
  agentType: AgentType;
  status: AgentEnvStatus | null;
}) {
  return (
    <SettingsItem
      title={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="w-16 justify-center">
            {agentType}
          </Badge>
          {status?.resolvedPath ? (
            <span
              className="truncate font-mono text-xs"
              title={status.resolvedPath}
            >
              {status.resolvedPath}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {status ? "未找到 CLI" : "未检测"}
            </span>
          )}
        </div>
      }
      description={
        <div className="flex flex-wrap items-center gap-2">
          {status?.resolvedPath && (
            <Badge variant={status.source === "custom" ? "default" : "outline"}>
              {status.source === "custom" ? "覆盖" : "系统"}
            </Badge>
          )}
          {status?.version && (
            <span className="text-xs">v{status.version}</span>
          )}
        </div>
      }
    />
  );
}

// ── 只读 Runtime 区块 ─────────────────────────────────────────────────

function ReadOnlyRuntimeSection({ runtime }: { runtime: Runtime }) {
  const env = runtime.envStatus;

  return (
    <SettingsSection>
      <SettingsItem
        title={
          <div className="flex items-center gap-2">
            <span className="font-medium">{runtime.name}</span>
            <Badge variant="outline">
              {Object.keys(runtime.capabilities ?? {})
                .map(runtimeTypeLabel)
                .join(" / ") || "待配对"}
            </Badge>
            <Badge
              variant={runtime.status === "online" ? "default" : "secondary"}
            >
              {runtime.status === "online" ? "在线" : "离线"}
            </Badge>
          </div>
        }
        description={
          env?.detectedAt ? (
            <span>检测于 {formatDateTime(env.detectedAt)}</span>
          ) : undefined
        }
      />
      <ReadOnlyAgentItem agentType="claude" status={env?.claude ?? null} />
      <ReadOnlyAgentItem agentType="codex" status={env?.codex ?? null} />
    </SettingsSection>
  );
}

// ── 主面板 ────────────────────────────────────────────────────────────

/**
 * 用户侧 CLI 环境状态：只读列表，使用 SettingsSection + SettingsItem 风格，
 * 与「模型配置」页面保持一致。
 */
export function CliStatusPanel({
  showHeader = true,
}: {
  mode?: "admin" | "user";
  showHeader?: boolean;
}) {
  const { data: runtimes = [], isLoading } = useRuntimes();

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">CLI 环境状态</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            当前运行环境检测到的 Agent CLI 信息（只读）
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border bg-card"
            />
          ))}
        </div>
      ) : runtimes.length === 0 ? (
        <SettingsSection>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            暂无运行环境
          </div>
        </SettingsSection>
      ) : (
        <div className="space-y-3">
          {runtimes.map((rt) => (
            <ReadOnlyRuntimeSection key={rt.id} runtime={rt} />
          ))}
        </div>
      )}
    </div>
  );
}
