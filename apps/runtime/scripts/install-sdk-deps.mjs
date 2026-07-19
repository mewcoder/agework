#!/usr/bin/env node
// esbuild --external 后,dist/main.js 和 dist/runner.js 里的
// @anthropic-ai/claude-agent-sdk / @openai/codex-sdk import 是裸 specifier,
// 需要一份真实(非 pnpm 隔离式)node_modules 挂在 dist/ 旁边才能在运行时解析到
// 平台专属的原生二进制(见 apps/runtime/docs/adr/0001)。这里复用打 Docker 镜像
// 用的同一份锁定清单,跑一次真实 npm ci,让 dist/ 自成一体——
// Docker、server 内嵌(复制这份 dist/node_modules)、`pnpm dev` 的本地回退路径
// (resolveRuntimeEntry 直接用这里的 dist/main.js)三处都靠它。
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(runtimeRoot, "dist");
const sdkDepsDir = join(runtimeRoot, "sdk-deps");
const manifestPath = join(sdkDepsDir, "package.json");
const lockPath = join(sdkDepsDir, "package-lock.json");
const stampPath = join(distDir, ".sdk-install-stamp.json");
const manifestBytes = readFileSync(manifestPath);
const lockBytes = readFileSync(lockPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const npmVersion = execFileSync("npm", ["--version"], {
  encoding: "utf8",
}).trim();
const report = process.report?.getReport?.();
const libc = report?.header?.glibcVersionRuntime ?? "unknown";
const key = createHash("sha256")
  .update("agework-sdk-install-v1\0")
  .update(manifestBytes)
  .update(lockBytes)
  .update(process.platform)
  .update(process.arch)
  .update(libc)
  .update(process.versions.modules ?? "unknown")
  .update(npmVersion)
  .digest("hex");
const expectedVersions = manifest.dependencies;

function installedPackageVersion(packageName) {
  const packagePath = join(
    distDir,
    "node_modules",
    ...packageName.split("/"),
    "package.json"
  );
  if (!existsSync(packagePath)) return undefined;
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

function canReuseInstall() {
  if (!existsSync(stampPath)) return false;
  const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  if (stamp.key !== key) return false;
  return Object.entries(expectedVersions).every(
    ([name, version]) => installedPackageVersion(name) === version
  );
}

mkdirSync(distDir, { recursive: true });

if (canReuseInstall()) {
  copyFileSync(manifestPath, join(distDir, "package.json"));
  copyFileSync(lockPath, join(distDir, "package-lock.json"));
  console.log(`sdk deps unchanged → ${join(distDir, "node_modules")}`);
  process.exit(0);
}

const installDir = join(distDir, `.sdk-install-${process.pid}`);
rmSync(installDir, { recursive: true, force: true });
mkdirSync(installDir, { recursive: true });
copyFileSync(manifestPath, join(installDir, "package.json"));
copyFileSync(lockPath, join(installDir, "package-lock.json"));

try {
  execFileSync(
    "npm",
    ["ci", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: installDir, stdio: "inherit", shell: true }
  );

  for (const [name, version] of Object.entries(expectedVersions)) {
    const installedPath = join(
      installDir,
      "node_modules",
      ...name.split("/"),
      "package.json"
    );
    const installedVersion = JSON.parse(
      readFileSync(installedPath, "utf8")
    ).version;
    if (installedVersion !== version) {
      throw new Error(
        `SDK dependency version mismatch for ${name}: expected ${version}, got ${installedVersion}`
      );
    }
  }

  rmSync(join(distDir, "node_modules"), { recursive: true, force: true });
  renameSync(join(installDir, "node_modules"), join(distDir, "node_modules"));
  copyFileSync(manifestPath, join(distDir, "package.json"));
  copyFileSync(lockPath, join(distDir, "package-lock.json"));

  const stamp = {
    schemaVersion: 1,
    key,
    platform: process.platform,
    arch: process.arch,
    libc,
    nodeAbi: process.versions.modules ?? "unknown",
    npmVersion,
    packages: expectedVersions,
  };
  const nextStampPath = `${stampPath}.${process.pid}`;
  writeFileSync(nextStampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  renameSync(nextStampPath, stampPath);
  console.log(`installed sdk deps → ${join(distDir, "node_modules")}`);
} finally {
  rmSync(installDir, { recursive: true, force: true });
}
