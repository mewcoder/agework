/**
 * Codex app-server protocol version metadata.
 *
 * The generated types in `generated/` are produced by `codex app-server
 * generate-ts` for a specific codex version. This constant records that
 * version so the client can compare it at runtime with the version reported
 * by the server during `initialize` (【决策1】 version gate).
 *
 * When upgrading codex:
 * 1. Update the codex binary.
 * 2. Re-run `codex app-server generate-ts --out packages/adapters/src/codex/base/app-server/generated`.
 * 3. Update this constant to match the new version.
 * 4. Review the diff of generated types.
 * 5. Run fixtures + smoke test.
 */

/** The codex version that the generated types in `generated/` were produced from. */
export const CODEX_GENERATED_VERSION = "0.144.1";
