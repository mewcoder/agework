import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listChangedFiles,
  readFileDiff,
  NotGitRepositoryError,
} from "./git";

function git(root: string, args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

/** 建一个带初始 commit 的临时 git 仓库,返回其根路径。 */
function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "git-spec-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "tracked.txt"), "line1\nline2\n");
  writeFileSync(join(root, "to-delete.txt"), "gone\n");
  writeFileSync(join(root, "to-rename.txt"), "rename me\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

describe("listChangedFiles", () => {
  let root: string;
  beforeEach(() => {
    root = initRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("detects modified / added / deleted with numstat counts", async () => {
    writeFileSync(join(root, "tracked.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(root, "new.txt"), "brand new\n");
    rmSync(join(root, "to-delete.txt"));

    const { list, truncated } = await listChangedFiles(root);
    expect(truncated).toBe(false);
    const byPath = new Map(list.map((e) => [e.path, e]));

    const modified = byPath.get("tracked.txt");
    expect(modified?.status).toBe("modified");
    expect(modified?.additions).toBe(1);
    expect(modified?.deletions).toBe(0);

    const deleted = byPath.get("to-delete.txt");
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.deletions).toBe(1);

    // 未跟踪文件没有 numstat → additions/deletions 为 null
    const added = byPath.get("new.txt");
    expect(added?.status).toBe("added");
    expect(added?.additions).toBeNull();
    expect(added?.deletions).toBeNull();
  });

  it("detects staged rename with oldPath", async () => {
    renameSync(join(root, "to-rename.txt"), join(root, "renamed.txt"));
    git(root, ["add", "-A"]);

    const { list } = await listChangedFiles(root);
    const rename = list.find((e) => e.status === "renamed");
    expect(rename).toBeDefined();
    expect(rename?.path).toBe("renamed.txt");
    expect(rename?.oldPath).toBe("to-rename.txt");
  });

  it("returns empty list on a clean repo", async () => {
    const { list, truncated } = await listChangedFiles(root);
    expect(list).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("throws NotGitRepositoryError for non-git directory", async () => {
    const plain = mkdtempSync(join(tmpdir(), "plain-"));
    try {
      await expect(listChangedFiles(plain)).rejects.toBeInstanceOf(
        NotGitRepositoryError
      );
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("readFileDiff", () => {
  let root: string;
  beforeEach(() => {
    root = initRepo();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns before/after for a modified file", async () => {
    writeFileSync(join(root, "tracked.txt"), "changed\n");
    const diff = await readFileDiff(root, "tracked.txt");
    expect(diff.status).toBe("modified");
    expect(diff.before).toBe("line1\nline2\n");
    expect(diff.after).toBe("changed\n");
  });

  it("returns before=null for an added file", async () => {
    writeFileSync(join(root, "fresh.txt"), "hi\n");
    const diff = await readFileDiff(root, "fresh.txt");
    expect(diff.status).toBe("added");
    expect(diff.before).toBeNull();
    expect(diff.after).toBe("hi\n");
  });

  it("returns after=null for a deleted file", async () => {
    rmSync(join(root, "tracked.txt"));
    const diff = await readFileDiff(root, "tracked.txt");
    expect(diff.status).toBe("deleted");
    expect(diff.before).toBe("line1\nline2\n");
    expect(diff.after).toBeNull();
  });

  it("rejects a file larger than 1 MiB", async () => {
    const big = "x".repeat(1_048_577);
    writeFileSync(join(root, "big.txt"), big);
    await expect(readFileDiff(root, "big.txt")).rejects.toThrow("过大");
  });

  it("rejects a binary file", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3, 4]));
    await expect(readFileDiff(root, "bin.dat")).rejects.toThrow("二进制");
  });

  it("rejects path traversal", async () => {
    await expect(readFileDiff(root, "../escape.txt")).rejects.toThrow("..");
  });

  it("rejects absolute path", async () => {
    await expect(readFileDiff(root, "/etc/passwd")).rejects.toThrow(
      "绝对路径"
    );
  });
});
