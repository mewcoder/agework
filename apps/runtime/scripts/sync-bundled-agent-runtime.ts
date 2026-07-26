#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listBundledAgentPluginIds } from "../src/worker/agent/bundled-plugin-manifest.ts";
import { BUILTIN_AGENT_RUNTIME_REQUIREMENTS } from "../../../packages/adapters/src/runtime-requirements.ts";
import { listAcpProfiles } from "../../../packages/agent-acp/src/agents/registry.ts";
import type {
  AgentRuntimeRequirement,
  AgentRuntimeRequirements,
} from "../../../packages/agent-sdk/src/types.ts";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkDepsDir = join(runtimeRoot, "sdk-deps");
const packagePath = join(sdkDepsDir, "package.json");
const lockPath = join(sdkDepsDir, "package-lock.json");
const runtimeManifestPath = join(sdkDepsDir, "bundled-agent-runtime.json");
const write = process.argv.includes("--write");

type BundledAgentEntry = AgentRuntimeRequirement & {
  pluginId: string;
  acpExecutable?: string;
};

const acpProfiles = listAcpProfiles();
const sourceRequirements = new Map<string, AgentRuntimeRequirements>([
  ["builtin-agents", BUILTIN_AGENT_RUNTIME_REQUIREMENTS],
  [
    "acp",
    Object.fromEntries(
      acpProfiles.map((profile) => [
        profile.agentType,
        profile.runtimeRequirement,
      ])
    ),
  ],
]);

const agents: Record<string, BundledAgentEntry> = {};
for (const pluginId of listBundledAgentPluginIds()) {
  // Requirements come from current source so sync works before package builds.
  // The Worker registry remains the authority for which bundled plugin ids must
  // be covered, and validates each factory's id when it creates the plugins.
  const requirements = sourceRequirements.get(pluginId);
  if (!requirements) {
    throw new Error(
      `Bundled agent plugin ${pluginId} is missing from Runtime dependency sync`
    );
  }
  addPluginRequirements(pluginId, requirements);
  sourceRequirements.delete(pluginId);
}
if (sourceRequirements.size > 0) {
  throw new Error(
    `Runtime requirements declared for unregistered bundled plugins: ${[
      ...sourceRequirements.keys(),
    ].join(", ")}`
  );
}

for (const profile of acpProfiles) {
  const requirement = agents[profile.agentType];
  if (!requirement) {
    throw new Error(
      `ACP profile ${profile.agentType} is missing bundled Runtime requirements`
    );
  }
  requirement.acpExecutable = profile.command;
}

const sortedAgents = Object.fromEntries(
  Object.entries(agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agentType, requirement]) => [
      agentType,
      {
        pluginId: requirement.pluginId,
        npmPackages: sortRecord(requirement.npmPackages),
        ...(requirement.agentExecutable
          ? { agentExecutable: requirement.agentExecutable }
          : {}),
        ...(requirement.acpExecutable
          ? { acpExecutable: requirement.acpExecutable }
          : {}),
      },
    ])
);

const dependencies: Record<string, string> = {};
for (const [agentType, requirement] of Object.entries(sortedAgents)) {
  for (const [packageName, version] of Object.entries(
    requirement.npmPackages
  )) {
    const existing = dependencies[packageName];
    if (existing && existing !== version) {
      throw new Error(
        `Conflicting managed Runtime versions for ${packageName}: ${existing} vs ${version} (${agentType})`
      );
    }
    dependencies[packageName] = version;
  }
}

const currentPackage = readJson(packagePath);
const expectedPackage = {
  name: currentPackage.name,
  private: currentPackage.private,
  type: currentPackage.type,
  dependencies: sortRecord(dependencies),
};
const expectedRuntimeManifest = {
  schemaVersion: 1,
  agents: sortedAgents,
};

if (write) {
  writeJson(packagePath, expectedPackage);
  writeJson(runtimeManifestPath, expectedRuntimeManifest);
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: sdkDepsDir, stdio: "inherit" }
  );
}

assertJsonEqual(
  packagePath,
  expectedPackage,
  "Runtime dependency manifest is stale"
);
assertJsonEqual(
  runtimeManifestPath,
  expectedRuntimeManifest,
  "Bundled agent Runtime manifest is stale"
);
assertLockfile(dependencies);

console.log(
  `${write ? "synced" : "verified"} ${Object.keys(sortedAgents).length} bundled agents and ${Object.keys(dependencies).length} Runtime packages`
);

function addPluginRequirements(
  pluginId: string,
  requirements: Readonly<Record<string, AgentRuntimeRequirement>>
): void {
  for (const [agentType, requirement] of Object.entries(requirements)) {
    if (agents[agentType]) {
      throw new Error(
        `Duplicate bundled agent runtime declaration: ${agentType}`
      );
    }
    if (Object.keys(requirement.npmPackages).length === 0) {
      throw new Error(
        `Bundled agent ${agentType} requires at least one npm package`
      );
    }
    agents[agentType] = { pluginId, ...requirement };
  }
}

function assertLockfile(expectedDependencies: Record<string, string>): void {
  const lock = readJson(lockPath);
  const rootDependencies = lock.packages?.[""]?.dependencies;
  if (!sameJson(rootDependencies, sortRecord(expectedDependencies))) {
    throw new Error(
      "Runtime package-lock root dependencies are stale; run pnpm --filter @agework/runtime sync:bundled-agent-deps"
    );
  }
  for (const [packageName, version] of Object.entries(expectedDependencies)) {
    const installedVersion =
      lock.packages?.[`node_modules/${packageName}`]?.version;
    if (installedVersion !== version) {
      throw new Error(
        `Runtime package-lock is missing ${packageName}@${version} (found ${installedVersion ?? "nothing"})`
      );
    }
  }
}

function assertJsonEqual(
  path: string,
  expected: unknown,
  message: string
): void {
  let actual: unknown;
  try {
    actual = readJson(path);
  } catch {
    throw new Error(
      `${message}; run pnpm --filter @agework/runtime sync:bundled-agent-deps`
    );
  }
  if (!sameJson(actual, expected)) {
    throw new Error(
      `${message}; run pnpm --filter @agework/runtime sync:bundled-agent-deps`
    );
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  );
}
