import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { AgentType } from "@agework/shared";

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

type AgentSdkInfo = {
  id: AgentType;
  name: string;
  version: string;
};

export type AboutInfo = {
  platform: {
    name: string;
    description: string;
    version: string;
  };
  agents: AgentSdkInfo[];
};

const PLATFORM_DESCRIPTION =
  "支持本地化部署的多 Agent 工作台，通过 Web 页面使用 Claude、Codex 等 Agent，并集中管理模型服务、工作空间与对话";

const requireFromHere = createRequire(__filename);

function cleanVersion(version: string | undefined) {
  return version?.replace(/^[~^]/, "") ?? "";
}

function readPackageJson(path: string): PackageJson | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

function findNamedPackageJson(
  candidates: string[],
  packageName: string,
): PackageJson | undefined {
  for (const candidate of candidates) {
    const packageJson = readPackageJson(candidate);
    if (packageJson?.name === packageName) return packageJson;
  }
  return undefined;
}

function resolveInstalledPackageVersion(
  packageName: string,
  fallback?: string,
) {
  try {
    let current = dirname(requireFromHere.resolve(packageName));

    for (let i = 0; i < 20; i += 1) {
      const packagePath = join(current, "package.json");
      if (existsSync(packagePath)) {
        const packageJson = readPackageJson(packagePath);
        if (packageJson?.name === packageName && packageJson.version) {
          return packageJson.version;
        }
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Fall back to the declared dependency range below.
  }

  return cleanVersion(fallback);
}

@Injectable()
export class SystemService {
  private readonly rootPackage = findNamedPackageJson(
    [
      join(process.cwd(), "..", "..", "package.json"),
      join(process.cwd(), "package.json"),
    ],
    "agework",
  );

  private readonly apiPackage = findNamedPackageJson(
    [
      join(process.cwd(), "package.json"),
      join(process.cwd(), "apps", "api", "package.json"),
    ],
    "api",
  );

  about(): AboutInfo {
    const dependencies = this.apiPackage?.dependencies ?? {};

    return {
      platform: {
        name: "AgeWork",
        description: PLATFORM_DESCRIPTION,
        version: cleanVersion(this.rootPackage?.version),
      },
      agents: [
        {
          id: "claude",
          name: "Claude Agent SDK",
          version: resolveInstalledPackageVersion(
            "@anthropic-ai/claude-agent-sdk",
            dependencies["@anthropic-ai/claude-agent-sdk"],
          ),
        },
        {
          id: "codex",
          name: "Codex SDK",
          version: resolveInstalledPackageVersion(
            "@openai/codex-sdk",
            dependencies["@openai/codex-sdk"],
          ),
        },
      ],
    };
  }
}
