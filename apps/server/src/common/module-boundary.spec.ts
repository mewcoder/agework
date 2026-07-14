import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 模块边界护栏：扫描 apps/server/src 下的跨模块 import，确保跨模块只触碰对方公开面。
 *
 * 公开面定义见 .claude/rules/backend-architecture.md：
 *  - 根 Service（`*.service.ts`）是 module 唯一对外入口。
 *  - 后端跨模块契约类型放 `*.types.ts` / `*.events.ts`。
 *  - Auth 的 `decorators/` `guards/` 是被明确允许的跨模块 TS 公开面。
 *  - `config/registry/*` 是 config 发布的纯常量 / env-key（无 DI、无状态）。
 *
 * 禁止：跨模块 import 对方 `*.repository.ts` 或 reach 进对方 internal 子目录里的 provider。
 */

const SRC_ROOT = path.resolve(__dirname, "..");

const FEATURES = new Set([
  "agent",
  "auth",
  "config",
  "conversation",
  "model-provider",
  "prisma",
  "run",
  "run-event",
  "runtime",
  "system",
  "user",
  "runtime-host",
  "workspace",
]);

// 允许被跨模块 import 的公开面文件后缀。
const PUBLIC_SUFFIXES = [
  ".module.ts",
  ".service.ts",
  ".types.ts",
  ".events.ts",
];

// 允许被跨模块 import 的公开子目录（按规则明确开放）。
const PUBLIC_DIRS = ["auth/decorators/", "auth/guards/", "config/registry/"];

const IMPORT_RE = /import\s+(?:type\s+)?(?:[^"']*?from\s+)?["']([^"']+)["']/g;

type CrossImport = { from: string; target: string };

function sourceFiles(): string[] {
  return execSync(`find ${SRC_ROOT} -name '*.ts' -not -name '*.spec.ts'`)
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

function topFeature(relFromSrc: string): string {
  return relFromSrc.split(path.sep)[0];
}

function collectCrossImports(): CrossImport[] {
  const result: CrossImport[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, "utf8");
    const fromRel = path.relative(SRC_ROOT, file);
    const fromFeature = topFeature(fromRel);
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(src))) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const resolvedRel = path.relative(
        SRC_ROOT,
        path.resolve(path.dirname(file), spec)
      );
      const targetFeature = topFeature(resolvedRel);
      if (!FEATURES.has(targetFeature)) continue;
      if (targetFeature === fromFeature) continue;
      result.push({ from: fromRel, target: resolvedRel });
    }
  }
  return result;
}

function isPublicSurface(target: string): boolean {
  if (PUBLIC_SUFFIXES.some((suffix) => `${target}.ts`.endsWith(suffix))) {
    return true;
  }
  return PUBLIC_DIRS.some((dir) => target.startsWith(dir));
}

describe("module boundary", () => {
  const crossImports = collectCrossImports();

  it("never imports another module's repository across boundaries", () => {
    const offenders = crossImports.filter((c) =>
      c.target.endsWith(".repository")
    );
    expect(offenders.map((c) => `${c.from} -> ${c.target}`).sort()).toEqual([]);
  });

  it("only reaches another module's public surface", () => {
    const offenders = crossImports.filter((c) => !isPublicSurface(c.target));
    expect(offenders.map((c) => `${c.from} -> ${c.target}`).sort()).toEqual([]);
  });
});
