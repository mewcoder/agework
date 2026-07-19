import { fileURLToPath } from "node:url";

/**
 * Absolute path to the runnable fake ACP agent script (`fake-acp-agent.mjs`).
 * Spawn it with `node <path>` to get a real ACP agent over stdio. Scenario is
 * controlled via `FAKE_ACP_*` environment variables (see the script header).
 *
 * Test-only helper: resolved via `import.meta.url`, which Vitest handles
 * correctly for imported source modules (`__dirname`/`require` are unreliable
 * there). The `testing/` folder is excluded from the CommonJS `tsc` build.
 */
export const FAKE_ACP_AGENT_PATH = fileURLToPath(
  new URL("./fake-acp-agent.script.mjs", import.meta.url)
);
