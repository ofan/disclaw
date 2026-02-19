# Disclaw Architecture

Discord workspace structure + OpenClaw routing managed as code.

## Commands

| Command | Direction | Writes to | Default |
|---------|-----------|-----------|---------|
| `diff` | — | nothing | read-only |
| `apply` | config → Discord | Discord + OpenClaw | dry-run, `--yes` to mutate |
| `import` | Discord → config | disclaw.yaml | dry-run, `--yes` to write |
| `rollback` | snapshot → Discord | Discord + OpenClaw | dry-run, `--yes` to mutate |

All commands (except validate) support:
- `-f, --filters <types>` — filter by resource type (category, channel, thread, binding)
- `-j, --json` — flat array output `[{op, type, name, ...}]` for agent/LLM integration

## System Diagram

```
disclaw.yaml (desired state)
        │
        ▼
   ┌─────────┐
   │  Parser  │──validates + normalizes (Zod)
   └────┬─────┘
        ▼
  ┌────────────┐     ┌──────────────────┐
  │ Reconciler │◄────│ State Providers   │
  │            │     │  ├─ DiscordProvider (discord.js)
  └────┬───────┘     │  └─ OpenClawCLIProvider (openclaw CLI)
       │             └──────────────────┘
       ▼
  ┌───────────┐
  │ Snapshots │──JSON in .disclaw/snapshots/
  └───────────┘
```

## Provider Interface

```typescript
interface StateProvider<T> {
  fetch(): Promise<T>
  apply(actions: Action[]): Promise<void>
  verify(expected: T): Promise<boolean>
}
```

OpenClaw's API is unstable. All OpenClaw interaction is isolated in
`src/providers/openclaw.ts` — when the CLI shape changes, fix one file.

## Components

| Component | File | Responsibility |
|---|---|---|
| CLI entrypoint | `src/cli.ts` | Arg parsing (commander), routes to commands |
| Commands | `src/commands/{diff,apply,import,rollback}.ts` | Orchestrate workflow per command |
| Parser | `src/parser.ts` | Load + validate disclaw.yaml with Zod |
| Reconciler | `src/reconciler.ts` | Diff desired vs actual → action list |
| Filter | `src/filter.ts` | Apply -f type filters to actions/resources |
| Formatter | `src/format.ts` | Human-readable + JSON output |
| Discord Provider | `src/providers/discord.ts` | discord.js — fetch/mutate Discord resources |
| OpenClaw Provider | `src/providers/openclaw.ts` | Shell to `openclaw config get/set` for bindings |
| Snapshot | `src/snapshot.ts` | Save/load pre-apply state to .disclaw/snapshots/ |
| Types | `src/types.ts` | Shared interfaces and provider contracts |

## Data Flows

### diff
1. Parse disclaw.yaml → validated desired state
2. DiscordProvider.fetch() → current Discord state
3. OpenClawProvider.fetch() → current bindings
4. Reconciler.diff(desired, actual) → actions + unmanaged resources
5. Apply filters if -f provided
6. Output: human-readable diff or -j flat array

### apply
1. Run diff internally → action list
2. Apply filters → scoped action list
3. Without --yes: print diff, exit (dry-run default)
4. Snapshot current state → .disclaw/snapshots/<timestamp>.json
5. Execute in dependency order: category → channels → threads → bindings
6. Verify via provider.verify() — re-fetch and compare
7. Exit 0 only after verify passes

### import
1. Fetch Discord state, compare against config
2. Detect unmanaged categories, channels, threads
3. Detect unbound OpenClaw agents
4. Apply filters → scoped import list
5. Without --yes: print what would be imported, exit
6. Write to disclaw.yaml preserving existing YAML structure
7. Categories imported with their child channels nested inside

### rollback
1. Load most recent snapshot
2. Diff snapshot vs current state (not vs post-apply)
3. Flag drifted resources with before/after values
4. Without --yes: print diff, exit
5. Take pre-rollback snapshot (rollback is reversible)
6. Apply snapshot as desired state through reconciler
7. Verify

## OpenClaw Integration

- **Read**: `openclaw config get bindings --json`
- **Write**: `openclaw config set bindings <json> --json`
- **Agents**: `openclaw agents list --json` → `[{id: string}]`
- **Token**: `openclaw config get channels.discord.token`
- **Backups**: Handled automatically by `openclaw config set` (.bak rotation)
- Zod validates all responses to detect API drift

## Schema v1

Nested structure in disclaw.yaml:

```yaml
version: 1
managedBy: disclaw
guild: "YOUR_GUILD_ID"

channels:
  - name: general                    # standalone channel
    threads: [Ideas, Planning]       # inline thread list

  - category: Homelab                # category group
    channels:
      - name: homelab
        topic: "Homelab ops"
        threads: [K8s, Networking]
      - name: homelab-alerts

openclaw:
  requireMention: false              # guild-level default
  agents:
    main: homelab                    # shorthand: agent → channel
    siren:                           # object form: per-agent overrides
      channel: siren
      requireMention: true
```

`flattenDesiredState()` extracts flat lists for reconciler consumption.

## JSON Output Format

Flat array, every entry has `op`, `type`, `name`:

```json
[
  {"op": "create", "type": "category", "name": "Homelab"},
  {"op": "update", "type": "channel", "name": "notifications",
   "before": {"topic": "old"}, "after": {"topic": "new"}},
  {"op": "noop", "type": "channel", "name": "general"},
  {"op": "unmanaged", "type": "category", "name": "Personal"},
  {"op": "unbound", "type": "agent", "name": "coder"},
  {"op": "pin", "type": "pin", "name": "general", "count": 1}
]
```

## Safety Rules

1. Dry-run by default — `--yes` required for mutations
2. Snapshot before any apply
3. Managed-scope writes only (`managedBy: disclaw`)
4. Never delete unmanaged resources
5. Deterministic output (stable ordering)
6. Zod validation on all external API responses
7. `execFileSync` (array args) only — never `execSync` with shell strings
8. Rollback is always available and drift-aware
