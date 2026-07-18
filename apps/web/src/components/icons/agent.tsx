import { Claude, Codex, OpenCode, Pi } from "@lobehub/icons";
import type { AgentType } from "@/stores/selection-store";

type AgentIconProps = {
  agent?: AgentType | string;
  size?: number;
  className?: string;
};

export function AgentIcon({
  agent,
  size = 14,
  className = "shrink-0",
}: AgentIconProps) {
  if (agent === "codex") {
    return <Codex.Avatar size={size} className={className} />;
  }

  if (agent === "opencode") {
    return <OpenCode.Avatar size={size} className={className} />;
  }

  if (agent === "pi") {
    return <Pi.Avatar size={size} className={className} />;
  }

  return <Claude.Avatar size={size} className={className} />;
}
