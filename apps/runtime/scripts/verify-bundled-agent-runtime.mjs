#!/usr/bin/env node
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = process.argv[2] ?? defaultRoot;
const manifestPath = join(runtimeRoot, "bundled-agent-runtime.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.schemaVersion !== 1 || !manifest.agents) {
  throw new Error(`Unsupported bundled agent Runtime manifest: ${manifestPath}`);
}

const verifiedPackages = new Set();
for (const [agentType, requirement] of Object.entries(manifest.agents)) {
  for (const [packageName, expectedVersion] of Object.entries(
    requirement.npmPackages
  )) {
    if (verifiedPackages.has(packageName)) continue;
    const packagePath = join(
      runtimeRoot,
      "node_modules",
      ...packageName.split("/"),
      "package.json"
    );
    const installed = JSON.parse(await readFile(packagePath, "utf8"));
    if (installed.version !== expectedVersion) {
      throw new Error(
        `${agentType} requires ${packageName}@${expectedVersion}, found ${installed.version}`
      );
    }
    verifiedPackages.add(packageName);
  }

  for (const executable of [
    requirement.agentExecutable,
    requirement.acpExecutable,
  ].filter((value, index, values) => value && values.indexOf(value) === index)) {
    const executablePath = join(runtimeRoot, "node_modules", ".bin", executable);
    try {
      await access(executablePath, constants.X_OK);
    } catch {
      throw new Error(
        `Bundled agent ${agentType} requires executable ${executablePath}`
      );
    }
  }
}

console.log(
  `verified ${Object.keys(manifest.agents).length} bundled agents and ${verifiedPackages.size} Runtime packages`
);
