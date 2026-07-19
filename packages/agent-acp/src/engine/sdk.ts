import type * as acp from "@agentclientprotocol/sdk";

/**
 * The ACP SDK (`@agentclientprotocol/sdk`) is ESM-only, but `@agework/agent-acp`
 * is a CommonJS package. Load it lazily via dynamic import — the same pattern the
 * Codex adapter uses for its ESM-only SDK. Types are safe to import statically
 * (`import type`), only runtime values must go through {@link loadAcpSdk}.
 */
export type AcpSdk = typeof acp;

let sdkPromise: Promise<AcpSdk> | undefined;

/** Load (and cache) the ACP SDK module namespace. */
export function loadAcpSdk(): Promise<AcpSdk> {
  if (!sdkPromise) {
    sdkPromise = import("@agentclientprotocol/sdk");
  }
  return sdkPromise;
}
