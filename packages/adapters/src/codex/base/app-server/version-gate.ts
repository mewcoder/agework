/**
 * Version gate logic for the Codex app-server client (§9, 决策1).
 *
 * The generated TypeScript types in `generated/` are produced from a specific
 * codex version. At runtime, the server reports its version via the
 * `initialize` response's `userAgent` field. This module compares the two
 * versions and produces a {@link VersionGateResult}.
 */

import type { VersionGateConfig, VersionGateResult } from "./types";

/**
 * Parse a semver-like version string into a comparable tuple.
 *
 * Supports versions like `0.144.1`, `1.0.0-rc.1`, `0.200.0-dev.42`.
 * Returns `null` if the string cannot be parsed.
 */
export function parseVersion(v: string): [number, number, number] | null {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Extract the codex version from an app-server `userAgent` string.
 *
 * The `userAgent` field in the `initialize` response may appear in
 * several formats depending on the codex version:
 *   `codex-cli/0.144.1 (...)` or `codex-cli/1.2.3`
 *   `codex/0.200.0`
 *   `codex 0.1.0`
 *
 * Returns the version string (e.g. `"0.144.1"`), or `null` if not found.
 */
export function extractCodexVersion(userAgent: string): string | null {
  // Handles `codex-cli/0.144.1`, `codex/0.200.0`, `codex-cli 0.144.1`
  const match = userAgent.match(/codex(?:-cli)?[\/\s]+(\d+\.\d+\.\d+[^\s)]*)/i);
  if (match) return match[1];
  // Fallback: bare semver at the start of the string (e.g. `0.144.1`)
  const bare = userAgent.match(/^(\d+\.\d+\.\d+)/);
  if (bare) return bare[1];
  return null;
}

/**
 * Compare two versions. Returns:
 * - `0` if equal
 * - negative if `a` < `b`
 * - positive if `a` > `b`
 */
export function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Run the version gate check (【决策1】).
 *
 * Logic:
 * 1. Parse both versions.
 * 2. If the generated version is unparseable, that's a programming error —
 *    always returns `incompatible`.
 * 3. If the runtime version is unparseable, returns `incompatible` (we can't
 *    trust an unknown version).
 * 4. If major and minor match (patch may differ), returns `compatible`.
 * 5. If major matches but minor differs, returns `degraded` (minor drift).
 * 6. If major differs, returns `incompatible`.
 *
 * @param config The gate configuration (includes `generatedVersion`).
 * @param codexVersion The version reported by the server at runtime.
 */
export function checkVersionGate(
  config: VersionGateConfig,
  codexVersion: string | null,
): VersionGateResult {
  const genParsed = parseVersion(config.generatedVersion);
  if (!genParsed) {
    return {
      status: "incompatible",
      codexVersion: codexVersion ?? "unknown",
      reason: `Generated version "${config.generatedVersion}" is unparseable`,
    };
  }

  if (!codexVersion) {
    // ADR-0001 decision 3: "Registered/用户自带 codex 为 best-effort,不阻塞"
    // When we can't extract a version, we degrade but don't block —
    // the runtime codex might be a user-supplied binary with a different
    // userAgent format that we don't recognize.
    return {
      status: "degraded",
      codexVersion: "unknown",
      reason: "Server did not report a parseable codex version (best-effort, non-blocking)",
    };
  }

  const rtParsed = parseVersion(codexVersion);
  if (!rtParsed) {
    return {
      status: "incompatible",
      codexVersion,
      reason: `Runtime version "${codexVersion}" is unparseable`,
    };
  }

  const cmp = compareVersions(rtParsed, genParsed);

  if (cmp === 0) {
    return { status: "compatible", codexVersion };
  }

  // Same major.minor = patch difference → compatible
  if (rtParsed[0] === genParsed[0] && rtParsed[1] === genParsed[1]) {
    return { status: "compatible", codexVersion };
  }

  // Same major, different minor → degraded
  if (rtParsed[0] === genParsed[0]) {
    const direction = cmp < 0 ? "older" : "newer";
    return {
      status: "degraded",
      codexVersion,
      reason: `Runtime ${codexVersion} is ${direction} than generated ${config.generatedVersion} (minor drift)`,
    };
  }

  // Different major → incompatible
  return {
    status: "incompatible",
    codexVersion,
    reason: `Runtime ${codexVersion} has major version ${rtParsed[0]}, generated has ${genParsed[0]}`,
  };
}

/**
 * Decide whether to throw based on the gate result and config.
 *
 * In strict mode, `incompatible` throws. In non-strict mode (default per
 * ADR-0001 decision 3: "best-effort,不阻塞"), all statuses are non-blocking.
 * `degraded` and `incompatible` (non-strict) are logged by the caller.
 *
 * @throws Error with kind `version_mismatch` when strict and incompatible.
 */
export function enforceVersionGate(
  result: VersionGateResult,
  config: VersionGateConfig,
): void {
  if (result.status === "incompatible" && (config.strict ?? false)) {
    const err = new Error(
      `Codex version mismatch: ${result.reason}`,
    ) as Error & { kind: string };
    err.kind = "version_mismatch";
    throw err;
  }
}
