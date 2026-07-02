#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "../../..");
const desktopDir = join(repoRoot, "apps", "desktop");
const resourcesDir = join(desktopDir, "resources");
const appDir = join(resourcesDir, "app");
const pnpmRoot = join(repoRoot, "node_modules", ".pnpm");

// ---------------------------------------------------------------------------
// Target platform resolution
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targetPlatform = getArg("--platform") ?? process.env.TARGET_PLATFORM ?? process.platform;
const targetArch = getArg("--arch") ?? process.env.TARGET_ARCH ?? process.arch;
const isWindowsTarget = targetPlatform === "win32";

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

console.log(`Target platform: ${targetPlatform}-${targetArch}`);

// ---------------------------------------------------------------------------
// Platform-specific binary definitions
// ---------------------------------------------------------------------------

const PLATFORM_CONFIGS = {
  "darwin-arm64": {
    claude: {
      pnpmPrefix: "@anthropic-ai+claude-agent-sdk-darwin-arm64@",
      binaryPath: join("node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-arm64", "claude"),
      outputName: "claude",
    },
    codex: {
      pnpmPrefix: "@openai+codex@",
      pnpmFilter: (name) => name.includes("darwin-arm64"),
      binaryPath: join("node_modules", "@openai", "codex", "vendor", "aarch64-apple-darwin", "bin", "codex"),
      outputName: "codex",
    },
  },
  "darwin-x64": {
    claude: {
      pnpmPrefix: "@anthropic-ai+claude-agent-sdk-darwin-x64@",
      binaryPath: join("node_modules", "@anthropic-ai", "claude-agent-sdk-darwin-x64", "claude"),
      outputName: "claude",
    },
    codex: {
      pnpmPrefix: "@openai+codex@",
      pnpmFilter: (name) => name.includes("darwin-x64"),
      binaryPath: join("node_modules", "@openai", "codex", "vendor", "x86_64-apple-darwin", "bin", "codex"),
      outputName: "codex",
    },
  },
  "win32-x64": {
    claude: {
      pnpmPrefix: "@anthropic-ai+claude-agent-sdk-win32-x64@",
      binaryPath: join("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"),
      outputName: "claude.exe",
    },
    codex: {
      pnpmPrefix: "@openai+codex@",
      pnpmFilter: (name) => name.includes("win32-x64"),
      binaryPath: join("node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      outputName: "codex.exe",
    },
  },
  "win32-arm64": {
    claude: {
      pnpmPrefix: "@anthropic-ai+claude-agent-sdk-win32-arm64@",
      binaryPath: join("node_modules", "@anthropic-ai", "claude-agent-sdk-win32-arm64", "claude.exe"),
      outputName: "claude.exe",
    },
    codex: {
      pnpmPrefix: "@openai+codex@",
      pnpmFilter: (name) => name.includes("win32-arm64"),
      binaryPath: join("node_modules", "@openai", "codex", "vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"),
      outputName: "codex.exe",
    },
  },
};

const platformKey = `${targetPlatform}-${targetArch}`;
const config = PLATFORM_CONFIGS[platformKey];
if (!config) {
  const supported = Object.keys(PLATFORM_CONFIGS).join(", ");
  throw new Error(`Unsupported target platform: ${platformKey}. Supported: ${supported}`);
}

// ---------------------------------------------------------------------------
// pnpm store helpers
// ---------------------------------------------------------------------------

function findPnpmDir(prefix, predicate = () => true) {
  const match = readdirSync(pnpmRoot).find(
    (name) => name.startsWith(prefix) && predicate(name),
  );
  if (!match) return null;
  return join(pnpmRoot, match);
}

/** Finds a CLI binary directory in the local pnpm store. Throws if not found. */
function findBinaryDir(pkgConfig) {
  const pnpmFilter = pkgConfig.pnpmFilter ?? (() => true);
  const dir = findPnpmDir(pkgConfig.pnpmPrefix, pnpmFilter);
  if (!dir) {
    throw new Error(
      `Package not found in pnpm store (prefix: ${pkgConfig.pnpmPrefix}).\n` +
      `Build ${targetPlatform} packages on a ${targetPlatform} machine.`,
    );
  }
  console.log(`  Found: ${basename(dir)}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Main: build resources
// ---------------------------------------------------------------------------

console.log("Resetting resources directory...");
rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

console.log("Deploying apps/server (production deps, includes worker and adapters)...");
execFileSync(
  "pnpm",
  ["--filter", "server", "deploy", "--prod", "--legacy", join(appDir, "server")],
  { cwd: repoRoot, stdio: "inherit" },
);

console.log("Copying apps/web/dist...");
cpSync(join(repoRoot, "apps", "web", "dist"), join(appDir, "web", "dist"), { recursive: true });

console.log("Building template.db (empty schema, no seed data)...");
const templateDb = join(resourcesDir, "template.db");
rmSync(templateDb, { force: true });
const schemaSql = execFileSync(
  "pnpm",
  ["--filter", "server", "exec", "prisma", "migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
  { cwd: repoRoot, encoding: "utf8" },
);
const db = new Database(templateDb);
db.exec(schemaSql);
db.close();
if (!existsSync(templateDb)) {
  throw new Error(`template database was not created at ${templateDb}`);
}

console.log(`Copying bundled Agent CLI binaries (${platformKey})...`);
const binDir = join(resourcesDir, "bin");
mkdirSync(binDir, { recursive: true });

console.log("  Claude CLI...");
const claudeDir = findBinaryDir(config.claude);
cpSync(join(claudeDir, config.claude.binaryPath), join(binDir, config.claude.outputName));

console.log("  Codex CLI...");
const codexDir = findBinaryDir(config.codex);
cpSync(join(codexDir, config.codex.binaryPath), join(binDir, config.codex.outputName));

if (!isWindowsTarget) {
  chmodSync(join(binDir, config.claude.outputName), 0o755);
  chmodSync(join(binDir, config.codex.outputName), 0o755);
}

console.log("Done. Resources staged at", resourcesDir);
