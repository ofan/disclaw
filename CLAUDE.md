# Disclaw

Discord workspace structure + OpenClaw routing managed as code.

## Commands
- `npm run disclaw -- validate` — validate config (no API calls, CI-safe)
- `npm run disclaw -- diff` — show diff
- `npm run disclaw -- apply --yes` — apply changes
- `npm run disclaw -- apply --yes --prune` — apply + delete unmanaged resources
- `npm run disclaw -- rollback --yes` — restore snapshot
- `npm run disclaw -- import --yes` — adopt unmanaged Discord resources

Config defaults to `~/.config/disclaw/disclaw.yaml`. Override with `-c <path>`, `--dir <dir>`, or `DISCLAW_DIR` env var.

All commands (except validate) support:
- `-f, --filters <types>` — comma-separated resource types: category, channel, thread, binding
- `-j, --json` — structured output for agent/LLM integration
- `-y, --yes` — approve mutations (required for apply/import/rollback)

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
- Reconciler diffs desired vs actual → deterministic action list
- Snapshots saved to `<dir>/snapshots/` before any mutation (default: `~/.config/disclaw/snapshots/`)

## Config Directory
- `--dir <dir>` — base directory for config + snapshots (default: `~/.config/disclaw/`)
- `-c, --config <path>` — explicit config file path (optional, defaults to `<dir>/disclaw.yaml`)
- `DISCLAW_DIR` env var — same as `--dir`
- Resolution: `-c` flag > `--dir`/`DISCLAW_DIR` > `~/.config/disclaw/`

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
- `restricted: true` on channels maps to Discord's `nsfw` flag
- Pins are read-only (displayed in diff output, not managed as config)

## MVP Scope
- Only: validate / diff / apply / rollback / import
- Only: categories, text channels, threads, OpenClaw agent bindings. Pins are read-only.
- Do NOT build beyond MVP without explicit scope update
