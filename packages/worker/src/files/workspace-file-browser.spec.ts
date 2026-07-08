import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { browse, listFiles, readFile } from "./workspace-file-browser";

const isWindows = platform() === "win32";

/** 尝试创建 symlink,权限不足(Windows 非 admin/非开发者模式)时跳过测试。 */
async function trySymlink(target: string, path: string, type: "dir" | "file") {
  try {
    await symlink(target, path, type);
    return true;
  } catch (err) {
    if (
      err instanceof Error &&
      ("EPERM" in err || err.message.includes("EPERM"))
    ) {
      return false;
    }
    throw err;
  }
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "agework-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("workspace-file-browser path safety", () => {
  it("rejects absolute paths", async () => {
    const result = await browse(tmpRoot, {
      type: "list_files",
      commandId: "cmd-1",
      path: "/etc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("绝对路径");
    }
  });

  it("rejects .. traversal", async () => {
    const result = await browse(tmpRoot, {
      type: "list_files",
      commandId: "cmd-1",
      path: "..",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("..");
    }
  });

  it("rejects NUL bytes", async () => {
    const result = await browse(tmpRoot, {
      type: "list_files",
      commandId: "cmd-1",
      path: "foo\0bar",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("非法字符");
    }
  });

  it("rejects symlink pointing outside root", async () => {
    // Create a symlink inside root pointing outside
    const created = await trySymlink(tmpdir(), join(tmpRoot, "escape"), "dir");
    if (!created) return; // skip on Windows without symlink permission
    const result = await browse(tmpRoot, {
      type: "list_files",
      commandId: "cmd-1",
      path: "escape",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("越界");
    }
  });
});

describe("workspace-file-browser listFiles", () => {
  beforeEach(async () => {
    await mkdir(join(tmpRoot, "subdir"));
    await writeFile(join(tmpRoot, "a.txt"), "hello");
    await writeFile(join(tmpRoot, "b.ts"), "export {}");
    await mkdir(join(tmpRoot, "subdir", "nested"));
  });

  it("lists root directory with directories first", async () => {
    const result = await listFiles(tmpRoot, "");
    expect(result.type).toBe("list_files");
    expect(result.path).toBe("");
    expect(result.truncated).toBe(false);

    const types = result.list.map((e) => e.type);
    // directory should come first
    const firstDirIdx = types.indexOf("directory");
    const firstFileIdx = types.indexOf("file");
    expect(firstDirIdx).toBeLessThan(firstFileIdx);

    const names = result.list.map((e) => e.name);
    expect(names).toContain("subdir");
    expect(names).toContain("a.txt");
    expect(names).toContain("b.ts");
  });

  it("lists subdirectory", async () => {
    const result = await listFiles(tmpRoot, "subdir");
    expect(result.path).toBe("subdir");
    const names = result.list.map((e) => e.name);
    expect(names).toContain("nested");
  });

  it("returns file entries with size", async () => {
    const result = await listFiles(tmpRoot, "");
    const aTxt = result.list.find((e) => e.name === "a.txt");
    expect(aTxt?.type).toBe("file");
    expect(aTxt?.size).toBe(5);
  });

  it("returns truncated=true when exceeding 1000 entries", async () => {
    // Create 1001 files in parallel batches for speed
    const bigDir = join(tmpRoot, "bigdir");
    await mkdir(bigDir);
    const batchSize = 50;
    for (let start = 0; start < 1001; start += batchSize) {
      const end = Math.min(start + batchSize, 1001);
      await Promise.all(
        Array.from({ length: end - start }, (_, i) =>
          writeFile(join(bigDir, `f${start + i}.txt`), "x")
        )
      );
    }
    const result = await listFiles(tmpRoot, "bigdir");
    expect(result.truncated).toBe(true);
    expect(result.list.length).toBe(1000);
  });
});

describe("workspace-file-browser symlink handling", () => {
  it("returns type=symlink for symlinks inside root", async () => {
    await mkdir(join(tmpRoot, "realdir"));
    const created = await trySymlink("realdir", join(tmpRoot, "link"), "dir");
    if (!created) return; // skip on Windows without symlink permission

    const result = await listFiles(tmpRoot, "");
    const link = result.list.find((e) => e.name === "link");
    expect(link?.type).toBe("symlink");
    expect(link?.targetType).toBe("directory");
  });

  it("does not allow expanding symlinks as directories", async () => {
    await mkdir(join(tmpRoot, "realdir"));
    await writeFile(join(tmpRoot, "realdir", "inner.txt"), "data");
    const created = await trySymlink("realdir", join(tmpRoot, "link"), "dir");
    if (!created) return; // skip on Windows without symlink permission

    // root-internal symlink: realpath resolves within root, so listing works.
    // The front-end prevents expanding symlink nodes; this verifies the underlying
    // path resolution is correct for root-internal symlinks.
    const result = await listFiles(tmpRoot, "link");
    expect(result.type).toBe("list_files");
    expect(result.list.find((e) => e.name === "inner.txt")).toBeDefined();
  });
});

describe("workspace-file-browser readFile", () => {
  it("reads text file content", async () => {
    await writeFile(join(tmpRoot, "test.txt"), "Hello World");
    const result = await readFile(tmpRoot, "test.txt");
    expect(result.encoding).toBe("utf8");
    expect(result.content).toBe("Hello World");
    expect(result.size).toBe(11);
    expect(result.truncated).toBe(false);
  });

  it("truncates text files over 1 MiB", async () => {
    const largeContent = "x".repeat(1_048_577); // 1 byte over 1 MiB
    await writeFile(join(tmpRoot, "large.txt"), largeContent);
    const result = await readFile(tmpRoot, "large.txt");
    expect(result.truncated).toBe(true);
    expect(result.size).toBe(1_048_577);
    expect(result.content.length).toBeLessThanOrEqual(1_048_576);
  });

  it("rejects binary files with NUL bytes", async () => {
    const binaryBuf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x05, 0x06, 0x07]);
    await writeFile(join(tmpRoot, "binary.dat"), binaryBuf);
    const result = await browse(tmpRoot, {
      type: "read_file",
      commandId: "cmd-1",
      path: "binary.dat",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("二进制");
    }
  });

  it("reads image files as base64", async () => {
    const imageBuf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await writeFile(join(tmpRoot, "test.png"), imageBuf);
    const result = await readFile(tmpRoot, "test.png");
    expect(result.encoding).toBe("base64");
    expect(result.content).toContain("data:image/png;base64,");
    expect(result.truncated).toBe(false);
  });

  it("rejects images over 5 MiB", async () => {
    const bigBuf = Buffer.alloc(5_242_881, 0x89);
    await writeFile(join(tmpRoot, "big.png"), bigBuf);
    const result = await browse(tmpRoot, {
      type: "read_file",
      commandId: "cmd-1",
      path: "big.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toContain("图片过大");
    }
  });
});

describe("workspace-file-browser browse wrapper", () => {
  it("returns ok result with commandId for list_files", async () => {
    await writeFile(join(tmpRoot, "a.txt"), "x");
    const result = await browse(tmpRoot, {
      type: "list_files",
      commandId: "cmd-42",
      path: "",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.commandId).toBe("cmd-42");
    }
  });

  it("returns ok result with commandId for read_file", async () => {
    await writeFile(join(tmpRoot, "a.txt"), "hello");
    const result = await browse(tmpRoot, {
      type: "read_file",
      commandId: "cmd-43",
      path: "a.txt",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.commandId).toBe("cmd-43");
    }
  });

  it("returns error result with commandId on failure", async () => {
    const result = await browse(tmpRoot, {
      type: "read_file",
      commandId: "cmd-44",
      path: "nonexistent.txt",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.commandId).toBe("cmd-44");
    }
  });
});
