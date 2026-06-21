import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(rootDir, ".agents");
const linkPath = join(agentsDir, "skills");
const targetPath = join(rootDir, ".claude", "skills");

if (!existsSync(targetPath)) {
  console.error(`Target not found: ${targetPath}`);
  process.exit(1);
}

mkdirSync(agentsDir, { recursive: true });

const relativeTarget = relative(agentsDir, targetPath);

let current;
try {
  current = lstatSync(linkPath);
} catch {
  current = null;
}

if (current?.isSymbolicLink() && readlinkSync(linkPath) === relativeTarget) {
  console.log(`Already linked: .agents/skills -> ${relativeTarget}`);
  process.exit(0);
}

if (current) {
  rmSync(linkPath, { recursive: true, force: true });
}

symlinkSync(relativeTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
console.log(`Linked .agents/skills -> ${relativeTarget}`);
