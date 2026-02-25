# Disclaw

Discord workspace structure + OpenClaw routing managed as code.

## Commands
- `npm run disclaw -- validate` — validate config (no API calls, CI-safe)
- `npm run disclaw -- diff` — show diff
- `npm run disclaw -- apply --yes` — apply changes
- `npm run disclaw -- apply --yes --prune` — apply + delete unmanaged resources
- `npm run disclaw -- rollback --yes` — restore snapshot
- `npm run disclaw -- import --yes` — adopt unmanaged Discord resources

Config defaults to `./disclaw.yaml` (CWD). Override with `-c <path>` or `DISCLAW_CONFIG` env var.

All commands (except validate) support:
- `-f, --filters <types>` — comma-separated resource types: category, channel, thread, binding
- `-j, --json` — structured output for agent/LLM integration
- `-y, --yes` — approve mutations (required for apply/import/rollback)
- `-s, --server <name>` — target a specific server (multi-server configs)

## Build / Test
- `npm run build` — compile TypeScript
- `npm run test` — run all tests
- `npx tsc --noEmit` — type check

## Architecture
- Provider pattern: Discord + OpenClaw behind `StateProvider<T>` interface
- OpenClaw: API-first (gateway HTTP at `/tools/invoke`), CLI fallback when gateway unavailable
  - `OpenClawAPIProvider` — uses `fetch()` to gateway, caches full config per command run
  - `OpenClawCLIProvider` — uses `execFileSync`, fallback path
  - `resolveOpenClawProvider()` — factory that probes API then falls back to CLI
- All OpenClaw interaction isolated in `src/providers/openclaw.ts`
- Reconciler diffs desired vs actual → deterministic action list; scoping guard skips bindings for channels outside current guild
- Multi-server: per-server `DiscordProvider`, shared `OpenClawProvider`, `ParsedConfig` normalizes both formats
- Single-file snapshots: `<config-basename>-snapshot.json` next to config file, combined `MultiServerSnapshot` format

## Config Resolution
- `-c, --config <path>` — explicit config file path
- `DISCLAW_CONFIG` env var — config file path
- Default: `./disclaw.yaml` (CWD)
- Resolution: `-c` flag > `DISCLAW_CONFIG` env var > `./disclaw.yaml`

## Snapshot Options
- Snapshots auto-saved before apply/rollback as `<config-basename>-snapshot.json`
- `--no-snapshot` — disable snapshot (apply/rollback only)
- `--snapshot <path>` — custom snapshot file path (apply/rollback only)
- `DISCLAW_SNAPSHOT` env var — path or `off`/`false`/`0` to disable
- Resolution: `--no-snapshot` > `--snapshot <path>` > `DISCLAW_SNAPSHOT` env var > auto-derived path

## Telemetry
- Token: built-in default (override via `DISCLAW_TELEMETRY_TOKEN`)
- Opt-out: `DISCLAW_TELEMETRY=0`
- Events: `command_run` + `command_done` (lifecycle only)
- Relay: `https://telemetry-relay.ryan-b4e.workers.dev` (CF Worker, separate repo at `~/projects/telemetry-relay`)
- SDK: `telemetry-relay-sdk` (from `~/projects/telemetry-relay/sdk/`)
- Override URL: `DISCLAW_TELEMETRY_URL`
- Implementation: `src/telemetry.ts` — `withTelemetry()` wraps command actions in `cli.ts`

## Gateway Options
- `--gateway-url <url>` — override gateway URL (default: `http://127.0.0.1:18789`)
- `--gateway-token <token>` — override gateway auth token
- Env vars: `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`
- Prerequisite: gateway tool must be allowed — add `gateway.tools.allow: ["gateway"]` to openclaw.json

## npm Package
- Published as `@ofan/disclaw` on npmjs.com (MIT license)
- Install: `npm install -g @ofan/disclaw`
- Skill published to ClawHub as `disclaw@1.0.0`

## Safety Rules (non-negotiable)
- Dry-run by default — `--yes` required for mutations
- Snapshot before apply
- Managed-scope writes only (`managedBy: disclaw`)
- Never delete unmanaged resources (unless `--prune`)
- Zod validation on all external API responses
- Rollback is always available and drift-aware

## Security
- Use `execFileSync` (array args) for all subprocess calls, NEVER `execSync` with string interpolation
- Validate all external responses with Zod before use
- Gateway auth tokens via env vars or CLI flags, never hardcoded

## Conventions
- `.ts` extensions for all imports (tsconfig has `rewriteRelativeImportExtensions: true`)
- Node.js built-in imports use `node:` protocol
- Tests use `node:test` built-in runner

## Schema
- v1 schema: nested categories, inline threads, `openclaw.agents` map
- Two config formats (both v1): single-server (`guild:` key) and multi-server (`servers:` map)
- `parseConfig()` returns `ParsedConfig { servers: Record<string, ServerConfig>, singleServer: boolean }`
- Single-server configs normalized to `servers.default`
- `restricted: true` on channels maps to Discord's `nsfw` flag
- `private: true` on channels denies @everyone ViewChannel (permission overwrite)
- `addBot: true` grants the bot ViewChannel + SendMessages on private channels
- Pins are read-only (displayed in diff output, not managed as config)

## MVP Scope
- Only: validate / diff / apply / rollback / import
- Only: categories, text channels, threads, OpenClaw agent bindings. Pins are read-only.
- Do NOT build beyond MVP without explicit scope update
