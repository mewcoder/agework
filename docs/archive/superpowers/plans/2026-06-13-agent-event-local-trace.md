# Agent Event Local Trace Plan

## Summary

- Keep the current runtime boundary: adapters continue to run inside the sandbox worker.
- Add local JSONL tracing for the two event streams that are currently hard to inspect:
  - raw SDK/agent events emitted by Claude/Codex adapters;
  - converted AG-UI events sent from worker to API/frontend.
- Keep the existing Assistant UI message snapshot persistence unchanged: `RuntimeMessageAggregator` continues to write aggregated `assistant-ui` content into `Message.content`.

## Current State

- `Run` stores lifecycle state only: status, error, runtime handle, heartbeat, start and finish timestamps.
- `Message` stores user messages and aggregated assistant-ui assistant messages.
- Raw SDK events were not reliably persisted before this change; the old API-process `AgentTraceLogger` has been removed.
- Converted AG-UI events are forwarded to the API and frontend, and are consumed by `RuntimeMessageAggregator`; they are not fully stored as events.
- Assistant UI output is already persisted as a message snapshot, not as individual events.

## Key Changes

- Add a worker-side `AgentEventTraceWriter` that writes raw SDK trace JSONL directly when a runtime log path is available, falling back to API trace envelopes.
- Add an API-side `AgentEventLogService` that writes host-local JSONL under:
  - `~/.agework/logs/runtime/<conversationId>.raw.jsonl`
  - `~/.agework/logs/runtime/<conversationId>.agui.jsonl`
- Each line includes `ts`, `source`, `name`, `runId`, `conversationId`, `workspaceId`, `agentType`, and `payload`.
- Raw SDK events and converted AG-UI events are separate files; they are not mixed in one JSONL stream.
- Extend `RunConfig` with an agent event trace config:
  - `enabled`
  - `logDir`
  - `rawFilePath`
  - `rawRuntimeFilePath`
  - `aguiFilePath`
  - `runId`
  - `conversationId`
  - `workspaceId`
  - `agentType`
- API builds the trace path when creating the run config.
  - The log directory is the application host's `~/.agework/logs/runtime`, not the user's workspace.
  - This keeps paths stable even when the adapter runs in a sandbox.
- API writes both important event layers:
  - raw SDK events received from Claude/Codex adapter trace hooks;
  - converted AG-UI events received from the worker before they are aggregated for Assistant UI.
- Keep Assistant UI persistence unchanged.
  - `RuntimeMessageAggregator` still builds the UI message snapshot.
  - `ConversationService.upsertMessage(... format: "assistant-ui")` still writes that snapshot to DB.

## Security And Size Controls

- Redact sensitive fields recursively before writing JSONL:
  - `apiKey`
  - `authorization`
  - `token`
  - `password`
  - `secret`
  - `jwt`
  - `cookie`
- Add environment config:
  - `AGENT_EVENT_TRACE_ENABLED=true`
  - `AGENT_EVENT_TRACE_MAX_FILE_MB=50`
- If a trace file reaches the max size, stop appending and write one final `trace.truncated` event to that file.

## Viewing Events

- Add a command-line viewer:
  - `pnpm agent:events -- --conversation <conversationId> --kind raw`
  - `pnpm agent:events -- --conversation <conversationId> --kind agui`
- Support filters:
  - `--conversation <conversationId>`
  - `--kind raw|agui`
  - `--run <runId>`
  - `--file <path>`
  - `--tail N`
  - `--follow`
  - `--source sdk.raw`
  - `--name TOOL_CALL_START`
  - `--json`
- The viewer scans `~/.agework/logs/runtime/*.raw.jsonl` and `*.agui.jsonl` by default.

## Test Plan

- Unit test the trace writer:
  - emits raw SDK trace envelopes;
  - redacts sensitive fields;
  - preserves run/conversation context.
- Unit test API event log service:
  - writes raw and AGUI events to separate files;
  - redacts sensitive fields;
  - stops at max file size.
- Unit test CLI viewer:
  - resolves trace files by run id;
  - filters by conversation, source, and name;
  - supports tail and JSON output.
- Run focused type checks only:
  - `pnpm --filter api typecheck`
  - `pnpm --filter @agework/worker typecheck`
  - `pnpm --filter @agework/adapters typecheck`
  - `pnpm --filter @agework/shared typecheck`
