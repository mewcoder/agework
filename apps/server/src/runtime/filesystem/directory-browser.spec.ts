import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectory, listDirectory } from "./directory-browser";

describe("directory-browser", () => {
  // realpathSync:macOS 上 os.tmpdir() 落在 /var 的符号链接下,listDirectory/createDirectory
  // 内部都会解析成真实路径(/private/var/...),这里跟着解析一次,断言才对得上。
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "directory-browser-test-")));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("listDirectory returns only subdirectories as full paths, sorted", () => {
    mkdirSync(join(tmpDir, "b-dir"));
    mkdirSync(join(tmpDir, "a-dir"));
    writeFileSync(join(tmpDir, "a-file.txt"), "");

    const result = listDirectory(tmpDir);

    expect(result.entries).toEqual([
      join(tmpDir, "a-dir"),
      join(tmpDir, "b-dir"),
    ]);
  });

  it("listDirectory throws when the path does not exist", () => {
    expect(() => listDirectory(join(tmpDir, "missing"))).toThrow(
      "目录不存在或不可访问"
    );
  });

  it("listDirectory throws when the path is a file, not a directory", () => {
    const filePath = join(tmpDir, "a-file.txt");
    writeFileSync(filePath, "");
    expect(() => listDirectory(filePath)).toThrow("必须指向一个目录");
  });

  it("createDirectory creates nested directories and returns the resolved path", () => {
    const target = join(tmpDir, "nested", "child");
    const result = createDirectory(target);
    expect(result.path).toBe(target);
    expect(listDirectory(join(tmpDir, "nested")).entries).toEqual([target]);
  });

  it("createDirectory throws for a relative path", () => {
    expect(() => createDirectory("relative/path")).toThrow("必须是绝对路径");
  });

  it("createDirectory throws for an empty path", () => {
    expect(() => createDirectory("  ")).toThrow("不能为空");
  });
});
