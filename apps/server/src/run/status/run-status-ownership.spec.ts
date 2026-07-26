import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = existsSync(resolve(process.cwd(), "src/run"))
  ? resolve(process.cwd(), "src")
  : resolve(process.cwd(), "apps/server/src");

function productionTypeScriptFiles(): string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter((path) => !path.endsWith(".spec.ts"));
}

function violations(
  pattern: RegExp,
  allowedRelativePaths: ReadonlySet<string>
): string[] {
  return productionTypeScriptFiles()
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"))
    .filter((path) => !allowedRelativePaths.has(path));
}

describe("run status ownership", () => {
  // 只锚定方法名不锚定接收者变量名,防止换个注入别名(如 this.conversations)绕过守卫。
  it("keeps Run persistence mutations inside RunStatusService", () => {
    expect(
      violations(
        /\.\s*(?:markRunning|markRequiresAction|markFinished|markError|markCancelled|markCancelling)\s*\(/,
        new Set(["run/status/run-status.service.ts"])
      )
    ).toEqual([]);
  });

  it("keeps Conversation settlement/recovery writes inside RunStatusService", () => {
    expect(
      violations(
        /\.\s*(?:setConversationRunStateForRun|reconcileConversationRunState)\s*\(/,
        new Set(["run/status/run-status.service.ts"])
      )
    ).toEqual([]);
  });
});
