import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adaptersRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedDir = join(adaptersRoot, "src/codex/base/app-server/generated");
const versionSource = readFileSync(
  join(adaptersRoot, "src/codex/base/app-server/version.ts"),
  "utf8"
);
const generatedVersion = versionSource.match(
  /CODEX_GENERATED_VERSION\s*=\s*"([^"]+)"/
)?.[1];

if (!generatedVersion) {
  throw new Error("Could not read CODEX_GENERATED_VERSION from version.ts");
}

// codex-sdk owns the matching codex CLI as an exact transitive dependency.
// Resolve through the SDK package so this works with pnpm's isolated layout.
const sdkEntry = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
const sdkRoot = dirname(dirname(sdkEntry));
const codexRoot = resolve(sdkRoot, "..", "codex");
const codexPackage = JSON.parse(
  readFileSync(join(codexRoot, "package.json"), "utf8")
);

if (codexPackage.version !== generatedVersion) {
  throw new Error(
    `Codex schema version mismatch: dependency=${codexPackage.version} expected=${generatedVersion}`
  );
}

const stampPath = join(generatedDir, ".agework-codex-version");
const sentinels = [
  join(generatedDir, "ReasoningEffort.ts"),
  join(generatedDir, "v2/UserInput.ts"),
  join(generatedDir, "v2/ThreadItem.ts"),
];
const currentStamp = existsSync(stampPath)
  ? readFileSync(stampPath, "utf8").trim()
  : undefined;

if (
  currentStamp === generatedVersion &&
  sentinels.every((path) => existsSync(path))
) {
  process.exit(0);
}

rmSync(generatedDir, { recursive: true, force: true });
mkdirSync(generatedDir, { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    join(codexRoot, "bin/codex.js"),
    "app-server",
    "generate-ts",
    "--out",
    generatedDir,
  ],
  { stdio: "inherit" }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`codex app-server generate-ts exited with ${result.status}`);
}

writeFileSync(stampPath, `${generatedVersion}\n`);
