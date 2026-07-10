/**
 * Agent CLI 一键安装（仅支持 local runtime）。
 * 把独立 CLI 包装进 runtime 专属目录，不走全局 `npm install -g`，
 * 避免跟机器上已有的系统安装冲突。安装完成后由调用方把返回路径写成 envConfigOverride。
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentType } from "@agework/shared";
import { resolveCliPackageName } from "@agework/shared/cli";
import { AGEWORK_HOST_CLI_DIR } from "../../config/registry/defaults";

const NPM_INSTALL_TIMEOUT_MS = 120_000;

/** 把 agentType 对应的独立 CLI 装进专属目录，返回装好后的可执行文件绝对路径。 */
export async function installCli(agentType: AgentType): Promise<string> {
  const dir = join(AGEWORK_HOST_CLI_DIR, agentType);
  mkdirSync(dir, { recursive: true });

  await runNpmInstall(dir, resolveCliPackageName(agentType));

  const binPath = resolveInstalledBinPath(dir, agentType);
  if (!binPath) {
    throw new Error(`安装完成但未找到可执行文件：${agentType}`);
  }
  return binPath;
}

function runNpmInstall(cwd: string, packageName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(
      npmCommand,
      ["install", "--prefix", cwd, `${packageName}@latest`],
      { timeout: NPM_INSTALL_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `npm install 失败（exit ${code}）：${stderr.trim().slice(-500)}`
          )
        );
      }
    });
  });
}

function resolveInstalledBinPath(
  dir: string,
  agentType: AgentType
): string | null {
  const binName = process.platform === "win32" ? `${agentType}.cmd` : agentType;
  const binPath = join(dir, "node_modules", ".bin", binName);
  return existsSync(binPath) ? binPath : null;
}
