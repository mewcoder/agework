import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isProd = process.argv.includes("--prod");

const envPairs = [
  {
    envPath: resolve(repoRoot, "apps/server/.env"),
    examplePath: resolve(repoRoot, "apps/server/.env.example"),
    label: "apps/server/.env",
  },
  {
    envPath: resolve(repoRoot, "apps/web/.env"),
    examplePath: resolve(repoRoot, "apps/web/.env.example"),
    label: "apps/web/.env",
  },
];

function readEnvValues(path) {
  const values = new Map();
  const content = readFileSync(path, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (match) values.set(match[1], unquoteEnvValue(match[2]));
  }

  return values;
}

function unquoteEnvValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function main() {
  let hasError = false;
  const output = [];

  for (const pair of envPairs) {
    if (!existsSync(pair.examplePath)) {
      output.push(`Missing ${pair.label}.example`);
      hasError = true;
      continue;
    }

    if (!existsSync(pair.envPath)) {
      output.push(
        `Missing ${pair.label}. Run pnpm ${isProd ? "init:prod" : "init:dev"} first.`
      );
      hasError = true;
      continue;
    }

    const exampleValues = readEnvValues(pair.examplePath);
    const envValues = readEnvValues(pair.envPath);
    const missingKeys = [...exampleValues.keys()].filter(
      (key) => !envValues.has(key)
    );

    if (missingKeys.length > 0) {
      hasError = true;
      output.push(`${pair.label} is missing required env keys:`);
      for (const key of missingKeys) {
        output.push(`  - ${key}`);
      }
    }

    if (missingKeys.length === 0) {
      output.push(`${pair.label} ok`);
    }
  }

  if (hasError) {
    output.push(
      `Please update the .env files manually, then rerun pnpm ${
        isProd ? "init:prod" : "init:dev"
      }.`
    );
  }

  if (output.length > 0) {
    console.log(output.join("\n"));
  }

  if (hasError) {
    process.exit(1);
  }
}

main();
