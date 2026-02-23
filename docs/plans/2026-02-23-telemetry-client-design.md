# Disclaw Telemetry Client — Design

**Date:** 2026-02-23

## Summary

Add opt-out telemetry to disclaw using a `withTelemetry()` wrapper pattern. Events are sent to the telemetry-relay CF Worker. Zero new dependencies — uses built-in `node:crypto`, `node:os`, and native `fetch`.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Consent model | Opt-out | Industry standard (Next.js, Turborepo). Disable with `DISCLAW_TELEMETRY=0` or `--no-telemetry` |
| Events | Command lifecycle only | `command_run` (start) + `command_done` (end with exit code, duration) |
| Identity | Machine ID | SHA-256 hash of `hostname + username`, truncated to 16 chars. Not PII. |
| Relay config | Hardcoded defaults + env override | Production URL baked in. Override with `DISCLAW_TELEMETRY_URL` / `DISCLAW_TELEMETRY_TOKEN` for dev |
| Integration pattern | `withTelemetry()` wrapper | Single touch point per command in cli.ts. Zero changes to command implementations |

## Architecture

### Module: `src/telemetry.ts`

Three exports:
- `telemetry.track(event, properties)` — queues an event in memory
- `telemetry.flush()` — batch POSTs queued events to relay, 1s timeout
- `withTelemetry(commandName, actionFn)` — wraps command action, tracks lifecycle, flushes before exit

### Data flow

```
disclaw diff
  → withTelemetry("diff", fn)
    → track("command_run", { command: "diff" })
    → run actual command → exitCode
    → track("command_done", { command: "diff", exitCode, durationMs })
    → flush() → POST /v1/events/batch (1s timeout)
    → process.exit(exitCode)
```

### Opt-out

- `DISCLAW_TELEMETRY=0` (or `false`/`off`) → all functions become noops
- `--no-telemetry` CLI flag → same effect
- CI environments (`CI=true`) → telemetry stays on (valuable signal)

### Machine ID

```ts
createHash("sha256").update(hostname() + userInfo().username).digest("hex").slice(0, 16)
```

Computed once, cached in module scope. Sent as `machineId` — relay maps to PostHog `distinct_id`.

### Event shape

```json
{
  "tool": "disclaw",
  "event": "command_run",
  "version": "1.1.0+abc123",
  "machineId": "a1b2c3d4e5f6g7h8",
  "properties": {
    "command": "diff",
    "os": "linux",
    "nodeVersion": "25.0.0",
    "ci": false,
    "filters": "channel,binding",
    "server": "default",
    "json": false
  }
}
```

`command_done` adds: `exitCode`, `durationMs`.

### Flush strategy

- Events queued in-memory array
- `flush()` sends single batch POST, `AbortSignal.timeout(1000)`
- Fetch failure or timeout → silently swallowed (telemetry never breaks CLI)
- `withTelemetry` always calls `flush()` before returning exit code

### Changes to existing code

- **`cli.ts`** — wrap each command's `.action()` with `withTelemetry()`, add `--no-telemetry` flag
- **No changes** to any command implementation files
- **No new dependencies** — `node:crypto`, `node:os`, native `fetch`

### Testing

- `src/telemetry.test.ts` — unit tests with mocked `fetch`
  - Opt-out via env var → noop
  - Event shape validation
  - Flush timeout handling
  - Error swallowing (fetch failure doesn't throw)
  - `withTelemetry` captures timing and exit code
- E2E: `wrangler dev` (relay) + `disclaw validate` → query local D1
