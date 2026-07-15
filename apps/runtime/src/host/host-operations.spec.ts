import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostWorkspaceOperations } from "./host-operations.js";

describe("HostWorkspaceOperations", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("owns Host-local directory operations", () => {
    const root = mkdtempSync(join(tmpdir(), "agework-host-ops-"));
    roots.push(root);
    const operations = new HostWorkspaceOperations();
    const child = join(root, "project");

    operations.createDirectory({ runtimeHostId: "host-1", path: child });

    expect(
      operations.listDirectory({ runtimeHostId: "host-1", path: root })
    ).toEqual({ path: root, entries: [child] });
  });
});
