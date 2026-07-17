import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AcpAgentProfile, AcpProfileEnvInput } from "./profile";

const PI_PROVIDER = "_agework";

/** ModelProvider 的 apiFormat → pi models.json 的 api 枚举(见 pi docs/models.md)。 */
function resolveApi(apiFormat?: string): string {
  if (apiFormat === "anthropic") return "anthropic-messages";
  if (apiFormat === "openai-responses") return "openai-responses";
  return "openai-completions";
}

/**
 * Custom 模式:pi 没有 OPENCODE_CONFIG_CONTENT 那样的 env 直通配置,自定义
 * provider 只认配置目录里的 models.json。在 tmpdir 下按配置内容 hash 生成
 * 稳定目录(幂等覆写,不碰用户 ~/.pi),经 `PI_CODING_AGENT_DIR` 指给 pi。
 * apiKey 走 `$AGEWORK_PI_API_KEY` env 间接引用,不落盘。
 * anthropic 格式的存库 baseUrl 不带 /v1,与 pi 内置 anthropic provider 的
 * baseUrl 形态一致,直传不修正(区别于 opencode profile)。
 */
function writeCustomAgentDir(input: AcpProfileEnvInput): string {
  const model = input.model ?? "";
  const modelsJson = {
    providers: {
      [PI_PROVIDER]: {
        name: "AgeWork",
        baseUrl: input.baseUrl,
        api: resolveApi(input.apiFormat),
        apiKey: "$AGEWORK_PI_API_KEY",
        models: [{ id: model }],
      },
    },
  };
  const settingsJson = { defaultProvider: PI_PROVIDER, defaultModel: model };
  const hash = createHash("sha256")
    .update(JSON.stringify([modelsJson, settingsJson]))
    .digest("hex")
    .slice(0, 16);
  const dir = join(tmpdir(), "agework-pi", hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson, null, 2));
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(settingsJson, null, 2)
  );
  return dir;
}

/**
 * Pi(@earendil-works/pi-coding-agent)本体没有 ACP 模式,经社区桥 pi-acp
 * (ACP ⇄ `pi --mode rpc`)接入;待官方 `--mode acp` 落地后只需改本 profile 的
 * spawn 目标。
 */
export const piAcpProfile: AcpAgentProfile = {
  agentType: "pi",
  displayName: "Pi",
  command: "pi-acp",
  args: [],
  npmPackage: "pi-acp",
  binaryName: "pi",
  buildEnv(input) {
    const env: Record<string, string> = {
      ...input.baseEnv,
      // AgeWork manages the CLI version; skip pi's startup version check.
      PI_SKIP_VERSION_CHECK: "1",
    };

    // System mode: let pi use its own auth.json / settings / models config.
    if (input.source === "system") return env;

    // Custom mode: inject an ephemeral provider config dir.
    if (input.baseUrl && input.model) {
      env.PI_CODING_AGENT_DIR = writeCustomAgentDir(input);
      // 配置目录重定向后 sessions 默认跟着走;把 session 存储钉回默认位置,
      // 保证 custom/system 两种模式共用同一 session 库(pi-acp session/load 依赖)。
      env.PI_CODING_AGENT_SESSION_DIR = join(
        homedir(),
        ".pi",
        "agent",
        "sessions"
      );
      if (input.apiKey) env.AGEWORK_PI_API_KEY = input.apiKey;
    }
    return env;
  },
  resolveLaunch(executablePath) {
    if (!executablePath) {
      return { command: "pi-acp", args: [], env: {} as Record<string, string> };
    }
    // installCli 把 pi 与 pi-acp 装进同一 prefix,bin 同目录;找不到兄弟文件回退 PATH。
    const binName = process.platform === "win32" ? "pi-acp.cmd" : "pi-acp";
    const sibling = join(dirname(executablePath), binName);
    return {
      command: existsSync(sibling) ? sibling : "pi-acp",
      args: [],
      env: { PI_ACP_PI_COMMAND: executablePath },
    };
  },
};
