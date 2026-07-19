import { Readable, Writable } from "node:stream";
import type { Stream } from "@agentclientprotocol/sdk";
import { loadAcpSdk } from "./sdk";

/**
 * Wrap a child process's stdio as an ACP {@link Stream} (newline-delimited JSON
 * over stdio).
 *
 * - `stdin`  carries the JSON-RPC messages *we* send to the agent.
 * - `stdout` carries the JSON-RPC messages the agent sends *back*.
 *
 * The agent's stdout is the ACP wire and MUST NOT be consumed anywhere else;
 * stderr is reserved for logs/diagnostics (see {@link AcpProcess}).
 */
export async function createStdioStream(
  stdin: Writable,
  stdout: Readable
): Promise<Stream> {
  const { ndJsonStream } = await loadAcpSdk();
  return ndJsonStream(
    Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(stdout) as ReadableStream<Uint8Array>
  );
}
