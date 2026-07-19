import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { piAcpProfile } from "./profile";
import { getAcpProfile, isAcpAgent } from "../registry";

const baseEnv = { PATH: "/usr/bin", HOME: "/home/x" };

const writtenDirs: string[] = [];

function buildCustomEnv(overrides: Record<string, string> = {}) {
  const env = piAcpProfile.buildEnv({
    source: "custom",
    baseEnv,
    apiKey: "sk-secret-123",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o",
    ...overrides,
  });
  if (env.PI_CODING_AGENT_DIR) writtenDirs.push(env.PI_CODING_AGENT_DIR);
  return env;
}

afterAll(() => {
  for (const dir of writtenDirs) rmSync(dir, { recursive: true, force: true });
});

describe("piAcpProfile", () => {
  it("launches via the pi-acp bridge, not pi itself", () => {
    expect(piAcpProfile.command).toBe("pi-acp");
    expect(piAcpProfile.args).toEqual([]);
  });

  it("resolveLaunch hands the resolved pi path to the bridge via env", () => {
    const launch = piAcpProfile.resolveLaunch!("/opt/bin/pi");
    // /opt/bin 下没有 pi-acp 兄弟文件,回退 PATH 上的 pi-acp。
    expect(launch.command).toBe("pi-acp");
    expect(launch.env.PI_ACP_PI_COMMAND).toBe("/opt/bin/pi");
  });

  it("resolveLaunch without a resolved path falls back to PATH lookup", () => {
    const launch = piAcpProfile.resolveLaunch!(undefined);
    expect(launch.command).toBe("pi-acp");
    expect(launch.env).toEqual({});
  });

  it("system mode uses pi's own config and injects nothing", () => {
    const env = piAcpProfile.buildEnv({ source: "system", baseEnv });
    expect(env.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.AGEWORK_PI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("custom mode writes an ephemeral config dir and pins the session dir", () => {
    const env = buildCustomEnv();
    expect(env.PI_CODING_AGENT_DIR).toBeTruthy();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toContain(
      join(".pi", "agent", "sessions")
    );
    expect(env.AGEWORK_PI_API_KEY).toBe("sk-secret-123");

    const models = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "models.json"), "utf-8")
    );
    expect(models.providers._agework.baseUrl).toBe(
      "https://api.example.com/v1"
    );
    expect(models.providers._agework.models).toEqual([{ id: "gpt-4o" }]);
    // API key is referenced via $ENV, never inlined on disk.
    expect(models.providers._agework.apiKey).toBe("$AGEWORK_PI_API_KEY");
    expect(JSON.stringify(models)).not.toContain("sk-secret-123");

    const settings = JSON.parse(
      readFileSync(join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf-8")
    );
    expect(settings).toEqual({
      defaultProvider: "_agework",
      defaultModel: "gpt-4o",
      quietStartup: true,
    });
  });

  it("derives pi's models.json api enum from apiFormat", () => {
    const api = (overrides: Record<string, string>) =>
      JSON.parse(
        readFileSync(
          join(buildCustomEnv(overrides).PI_CODING_AGENT_DIR, "models.json"),
          "utf-8"
        )
      ).providers._agework.api;

    expect(api({})).toBe("openai-completions");
    expect(api({ apiFormat: "openai-compatible" })).toBe("openai-completions");
    expect(api({ apiFormat: "openai-responses" })).toBe("openai-responses");
    expect(api({ apiFormat: "anthropic" })).toBe("anthropic-messages");
  });

  it("the config dir is stable for identical config and distinct across configs", () => {
    const a = buildCustomEnv();
    const b = buildCustomEnv();
    const c = buildCustomEnv({ model: "other-model" });
    expect(a.PI_CODING_AGENT_DIR).toBe(b.PI_CODING_AGENT_DIR);
    expect(a.PI_CODING_AGENT_DIR).not.toBe(c.PI_CODING_AGENT_DIR);
  });
});

describe("ACP profile registry (pi)", () => {
  it("resolves pi as an ACP agent", () => {
    expect(getAcpProfile("pi")).toBe(piAcpProfile);
    expect(isAcpAgent("pi")).toBe(true);
  });
});
