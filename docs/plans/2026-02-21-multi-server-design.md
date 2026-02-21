# Multi-Server Support

## Goal

Support managing multiple Discord servers from a single disclaw config file, with optional per-server agent bindings. No schema version bump — extend v1 by shape detection.

## Non-goals (deferred)

- Multi-gateway support (multiple OpenClaw instances) — clean extension later via per-server `gateway:` field
- Cross-server agent bindings — agents are per-server, matching OpenClaw's per-guild data model
- `disclaw migrate` command — not needed since v1 single-server form remains valid

---

## Config Schema

### Detection by shape

The parser detects two forms within `version: 1`:

- **Single-server** (existing): top-level `guild:` key
- **Multi-server** (new): top-level `servers:` key

Both are valid `version: 1`. No version bump.

### Single-server form (unchanged)

```yaml
version: 1
managedBy: disclaw
guild: "111111111111111111"

channels:
  - name: general
  - category: Engineering
    channels:
      - name: backend

openclaw:
  requireMention: false
  agents:
    main: general
```

### Multi-server form (new)

```yaml
version: 1
managedBy: disclaw

servers:
  production:
    guild: "111111111111111111"
    channels:
      - name: general
      - category: Engineering
        channels:
          - name: backend
          - name: frontend
      - category: Support
        channels:
          - name: tickets
            private: true
            addBot: true
    openclaw:
      requireMention: false
      agents:
        main: general
        support:
          channel: tickets
          requireMention: true

  staging:
    guild: "222222222222222222"
    channels:
      - name: general
      - category: QA
        channels:
          - name: testing
          - name: bugs
    openclaw:
      agents:
        main: general
```

### Key rules

- Server names are map keys — user-chosen, stable, used for `--server` targeting
- `guild:` inside each server block is the Discord guild ID
- `channels:` and `openclaw:` are scoped per-server (no global defaults, no inheritance)
- `requireMention` is per-server, not global — avoids inheritance confusion
- Same agent name in multiple servers is fine — OpenClaw bindings are per-guild at the data layer
- Channel names only need to be unique within their server block (same as current behavior)
- Binding refs are validated against their own server's channel list

---

## Terminology

- **"server"** in all user-facing output, docs, CLI flags, and error messages
- **"guild ID"** only when referring to the numeric Discord ID (the config field name `guild:`)
- Never say "guild" in output — say "server"

Output format with multi-server:

```
── production (My Cool Server) ──────────────
  ✓ #general                          noop
  + #frontend                         create

── staging (Staging Server) ─────────────────
  ✓ #general                          noop
  + QA/                               create
```

Shows config name (for targeting) and Discord name (for orientation). Discord name fetched from API at runtime.

---

## Config Resolution (simplified)

### Current (remove)

```
-c flag  →  --dir / DISCLAW_DIR  →  ~/.config/disclaw/disclaw.yaml
```

### New

```
-c flag  →  DISCLAW_CONFIG  →  ./disclaw.yaml (CWD)
```

Drop: `--dir`, `DISCLAW_DIR`, `~/.config/disclaw/` default directory.

Rationale: disclaw is a "config as code" tool. The config should live in a git repo, not a hidden system directory. CWD-based resolution matches Terraform, docker-compose, and other IaC tools.

### Environment variables

| Env var | Values | Default |
|---|---|---|
| `DISCLAW_CONFIG` | Path to config file | `./disclaw.yaml` |
| `DISCLAW_SNAPSHOT` | `off`/`false`/`0` to disable, or a file path | `<basename>-snapshot.json` |

### CLI flags

| Flag | Scope | Purpose |
|---|---|---|
| `-c, --config <path>` | All commands | Explicit config path |
| `--server <name>` / `-s <name>` | All commands except validate | Target one server |
| `--no-snapshot` | apply, rollback | Skip snapshot for this run |
| `--snapshot <path>` | apply, rollback | Custom snapshot file path |

### Config not found

```
$ disclaw diff
Error: No disclaw.yaml found in current directory.
Hint: create one with `disclaw import`, or specify a path with -c <path>.
```

---

## Snapshot Redesign

### Current (remove)

- `snapshots/` directory with timestamped JSON files
- `loadLatestSnapshot()` returns newest file in the directory
- Unbounded growth — no cleanup
- No guild identity in snapshot

### New: single file, basename-derived

Snapshot file lives next to the config file. Name derived from config basename:

```
config filename        → strip last ext → slugify dots → snapshot filename
disclaw.yaml           → disclaw        → disclaw      → disclaw-snapshot.json
prod.yaml              → prod           → prod         → prod-snapshot.json
my.prod.yaml           → my.prod        → my-prod      → my-prod-snapshot.json
```

One file. One rollback depth. Each `apply` overwrites the previous snapshot. Deeper history comes from git.

### Snapshot schema (multi-server)

```ts
interface Snapshot {
  timestamp: string;
  configHash: string;
  servers: Record<string, {         // keyed by server config name
    guildId: string;
    discord: DiscordState;
  }>;
  openclaw: OpenClawState;          // shared across servers
}
```

For single-server form, the snapshot uses the implicit server name `"default"`:

```ts
servers: {
  default: { guildId: "111...", discord: { ... } }
}
```

### Backward compatibility

Old snapshots (pre-multi-server) have `discord: DiscordState` at the top level. Migration shim in `loadSnapshot()`:

```ts
function loadSnapshot(path: string, guildId?: string): Snapshot | null {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  // Old format: { discord: DiscordState, openclaw: ... }
  if (raw.discord && !raw.servers) {
    return {
      ...raw,
      servers: { default: { guildId: guildId ?? "unknown", discord: raw.discord } },
    };
  }
  return raw;
}
```

### Rollback with multi-server

- `disclaw rollback -y` — rolls back ALL servers from the snapshot
- `disclaw rollback --server production -y` — rolls back only production
- The snapshot always contains all servers (combined pre-apply state)
- Pre-rollback snapshot is saved before rollback executes (rollback is reversible)

### Snapshot controls

```bash
# Default: snapshot on, file next to config
disclaw apply -y
# → Snapshot saved: disclaw-snapshot.json

# Disable for this run (CI, testing)
disclaw apply -y --no-snapshot

# Custom path
disclaw apply -y --snapshot /tmp/snap.json

# Disable via env var (automation)
DISCLAW_SNAPSHOT=off disclaw apply -y

# Custom path via env var
DISCLAW_SNAPSHOT=/backups/snap.json disclaw apply -y
```

### Gitignore

Users tracking config in git should add:

```gitignore
*-snapshot.json
```

---

## Import: All-Server Onboarding

### First-run: no config exists

The bot token (from OpenClaw config) gives access to `client.guilds.fetch()` — disclaw can see every server the bot is in.

```
$ disclaw import -y
No config found. Discovering servers from bot...

Found 3 servers:
  1. My Community (111111111111111111) — 12 channels, 3 categories
  2. Staging (222222222222222222) — 4 channels, 1 category
  3. Partner Server (333333333333333333) — 28 channels, 8 categories

Wrote disclaw.yaml with 3 servers.
```

Server names derived from Discord server name, slugified:
- `My Community` → `my-community`
- `Test 🎮` → `test` (emoji stripped)
- Collisions: append suffix (`test`, `test-2`)

### Existing config: discover new servers

Bot gets added to a 4th server:

```
$ disclaw import -y
── my-community ────────────────────────────
  No new resources.
── staging ─────────────────────────────────
  No new resources.

New server discovered:
  + test-server (444...) — 2 channels

Imported 1 new server into disclaw.yaml
```

### Import one server only

```
$ disclaw import --server staging -y
```

### Import into an empty server block

To import a specific server before the bot can auto-discover it, user adds an empty skeleton:

```yaml
servers:
  new-server:
    guild: "444444444444444444"
    channels: []
```

Then `disclaw import --server new-server -y` fills it in.

---

## Failure Modes

### Per-server errors don't block other servers

```
$ disclaw apply -y

── production (My Community) ───────────────
  ✓ Created #announcements
  Applied 1 change(s).

── staging (Staging) ───────────────────────
  ✗ Missing Permissions — bot needs "Manage Channels" in this server.
  Skipped all changes for staging.

Applied 1/2 servers. 1 server failed.
Hint: check bot permissions in staging. Snapshot available: disclaw rollback -y
```

**Strategy**: apply servers serially. On per-server failure, log the error, continue to next server. Report all failures at the end with rollback hint.

Rationale: failing one server shouldn't block an unrelated server. The combined snapshot covers rollback for all servers.

### Bot not in a server

```
── old-server ──────────────────────────────
  Error: server not found — bot may have been removed from this server.
  Hint: remove "old-server" from config, or re-invite the bot.
```

### Channel not visible (missing ViewChannel)

Cannot detect ahead of time — bot's `guild.channels.fetch()` only returns visible channels. A channel in config that doesn't exist to the bot shows as `create`. On apply:

```
  ✗ #secret-ops — failed: channel name already exists (bot may lack ViewChannel permission)
```

### Missing Manage Channels permission

Detected on first `apply` call. Error surfaces with hint:

```
  Error: Missing Permissions — bot needs "Manage Channels" in this server.
  Hint: check bot role position in Discord server settings.
```

### Partial apply within one server

Same as current: try/catch with `"applied N/M"` report + rollback hint. The snapshot covers restoration.

---

## CLI UX Changes

### New flag: `--server` / `-s`

Targets a single server from a multi-server config:

```bash
disclaw diff --server staging
disclaw apply --server production -y
disclaw rollback --server staging -y
disclaw import --server new-server -y
```

Without `--server`: all servers processed (except `validate`, which always checks all).

### Error on unknown server name

```
$ disclaw diff --server typo
Error: Server "typo" not found in config.
Available servers: production, staging
```

### JSON output includes server field

```json
[
  {"op": "create", "type": "channel", "server": "staging", "name": "testing", "category": "QA"},
  {"op": "noop", "type": "binding", "server": "production", "name": "main → general"}
]
```

LLM workflow: parse JSON, filter by `server` field.

### Filters compose with `--server`

```bash
disclaw diff --server staging -f binding        # bindings in staging only
disclaw apply -f channel -y                     # channels in all servers
disclaw diff --server production -f channel,thread  # channels + threads in production
```

### Validate always checks all servers

```
$ disclaw validate
Config: ./disclaw.yaml
✓ production: valid
✗ staging: binding "support" references channel "tickets" not defined in this server
Config invalid (1 error in staging)
```

No `--server` for validate — always validates everything. CI-safe.

---

## Architecture Changes

### Provider model

**Discord**: one shared `discord.js` Client, one `DiscordProvider` per guild.

```ts
const client = new Client({ intents: [...] });
await client.login(token);

for (const server of servers) {
  const discord = new DiscordProvider(client, server.guild);
  // ... reconcile, apply
}
```

`DiscordProvider` constructor gains an overload: `(client: Client, guildId: string)` in addition to the existing `(token: string, guildId: string)`. The token form calls `login()` internally (backward compat). The client form skips login (shared connection).

**OpenClaw**: one shared provider instance. Already multi-guild at the data layer (`channels.discord.guilds.<guildId>`). No changes needed.

### Reconciler

**No changes to the reconciler itself.** Run N reconciliations in a loop:

```ts
for (const server of servers) {
  const result = reconcile(server.desired, server.discord, sharedOpenclaw, { prune });
  // ...
}
```

**One critical guard**: stale binding detection must scope to the current guild's channel IDs. Currently, reconciling Guild A sees all OpenClaw bindings (including Guild B's) and would flag Guild B's channels as stale deletes.

Fix (in reconciler, ~2-3 lines): when scanning bindings for stale detection, skip any binding whose `match.peer.id` is not found in the current `discordState.channels`. This correctly limits stale detection to the guild being reconciled.

### Parser

Detect shape and normalize:

```ts
function parseConfig(raw: string): ParsedConfig {
  const doc = YAML.parse(raw);
  if (doc.guild) {
    // Single-server form → wrap in servers map
    return {
      servers: {
        default: {
          guild: doc.guild,
          channels: doc.channels,
          openclaw: doc.openclaw,
        }
      },
      singleServer: true,   // flag for output formatting
    };
  }
  if (doc.servers) {
    // Multi-server form → use directly
    return { servers: doc.servers, singleServer: false };
  }
  throw new Error("Config must have either 'guild' or 'servers' key");
}
```

Single-server form normalizes to `servers: { default: { ... } }` internally. Commands don't need to know the difference — they always iterate `servers`.

### Snapshot module

Replace directory-based approach with single-file:

```ts
function resolveSnapshotPath(configPath: string): string {
  const dir = dirname(configPath);
  const base = basename(configPath, extname(configPath));
  const slugified = base.replace(/\./g, "-");
  return join(dir, `${slugified}-snapshot.json`);
}

function saveSnapshot(snapshot: Snapshot, path: string): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

function loadSnapshot(path: string): Snapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migration shim: old format has discord: at top level
    if (raw.discord && !raw.servers) {
      return {
        ...raw,
        servers: { default: { guildId: "unknown", discord: raw.discord } },
      };
    }
    return raw;
  } catch {
    return null;
  }
}
```

No more `listSnapshots()`, `loadLatestSnapshot()`, or `mkdirSync`. Single file, overwrite on save, read-or-null on load.

### Snapshot resolution

```
--snapshot <path>  →  DISCLAW_SNAPSHOT  →  <basename>-snapshot.json
--no-snapshot      →  DISCLAW_SNAPSHOT=off  →  skip snapshot entirely
```

Snapshot path resolution in commands:

```ts
function resolveSnapshotOptions(opts: {
  snapshot?: string;
  noSnapshot?: boolean;
  configPath: string;
}): string | null {
  if (opts.noSnapshot) return null;

  const envVal = process.env.DISCLAW_SNAPSHOT;
  if (envVal && ["off", "false", "0"].includes(envVal.toLowerCase())) return null;
  if (envVal) return envVal;

  if (opts.snapshot) return opts.snapshot;

  return resolveSnapshotPath(opts.configPath);
}
```

### Types

New types:

```ts
interface ServerConfig {
  guild: string;
  channels: DesiredChannelEntry[];
  openclaw?: DesiredOpenClaw;
}

interface ParsedConfig {
  servers: Record<string, ServerConfig>;
  singleServer: boolean;            // true when parsed from guild: form
  warnings?: string[];
}
```

`DesiredState` (existing) becomes an alias for the single-server internal representation. Commands work with `ParsedConfig.servers`.

### Unbound agent warnings

With multi-server, an agent bound in production but not staging is intentional. Only warn about agents with zero bindings across all servers:

```
Unbound agents: analytics (not bound in any server)
```

Per-server unbinding is normal — not a warning.

---

## LLM / Skill Integration

### Discovery

```bash
$ disclaw validate -j
{"valid": true, "servers": ["production", "staging"]}
```

LLM reads the JSON, knows which servers exist.

### Targeted operations

```bash
$ disclaw diff --server staging -j
[{"op": "create", "type": "channel", "server": "staging", "name": "bugs", "category": "QA"}]

$ disclaw apply --server staging -y -j
[{"op": "create", "type": "channel", "server": "staging", "name": "bugs", "status": "ok"}]
```

### Config editing

LLM reads `disclaw.yaml`, finds the server block, edits it. The file is always in CWD (or at `DISCLAW_CONFIG`). One file to find, one file to edit.

### Import as onboarding

```bash
$ disclaw import -j -y
{"imported": [{"server": "my-community", "guild": "111...", "channels": 12}, ...]}
```

LLM can bootstrap the full config with one command.

---

## File Changes Summary

| File | Change | Size |
|---|---|---|
| `src/types.ts` | Add `ServerConfig`, `ParsedConfig`, evolve `Snapshot`, remove `DirOptions`/`resolveDirOptions` | Medium |
| `src/parser.ts` | Shape detection (`guild:` vs `servers:`), normalize to `ParsedConfig` | Medium |
| `src/providers/discord.ts` | Accept shared `Client` in constructor overload | Small |
| `src/reconciler.ts` | Add channel-scope guard for stale binding detection (~3 lines) | Small |
| `src/snapshot.ts` | Replace directory model with single-file, add `resolveSnapshotPath`, migration shim | Medium |
| `src/commands/diff.ts` | Loop over servers, per-server output headers, `--server` filter | Medium |
| `src/commands/apply.ts` | Loop over servers, per-server apply, combined snapshot, `--server` filter | Medium |
| `src/commands/rollback.ts` | Multi-server snapshot loading, `--server` scoping | Medium |
| `src/commands/import.ts` | All-server discovery, multi-server config writing, `--server` filter | Large |
| `src/cli.ts` | Add `--server`/`-s`, `--no-snapshot`, `--snapshot`, `DISCLAW_CONFIG`/`DISCLAW_SNAPSHOT`, remove `--dir` | Medium |
| Tests | Update all test fixtures and assertions | Large |

Estimated net change: ~400-500 lines (excluding tests).

---

## Migration Path

### For existing single-server users

Nothing changes. Their `version: 1` config with `guild:` continues to work unchanged. All commands behave identically. The only visible difference: config resolution defaults to CWD instead of `~/.config/disclaw/`.

Users who relied on `~/.config/disclaw/` default path can set `DISCLAW_CONFIG=~/.config/disclaw/disclaw.yaml` to preserve their workflow.

### For users upgrading to multi-server

1. Edit `disclaw.yaml`: wrap channels + openclaw under a named server key, replace `guild:` with `servers:`
2. Run `disclaw validate` to verify
3. Run `disclaw diff` to confirm no unintended changes
4. Done — no `migrate` command needed

### Old snapshots

The migration shim in `loadSnapshot()` handles old-format snapshots transparently. Rollback works across the format change.

### Removed features

| Removed | Replacement |
|---|---|
| `--dir <dir>` flag | `-c <path>` or `DISCLAW_CONFIG` |
| `DISCLAW_DIR` env var | `DISCLAW_CONFIG` env var |
| `~/.config/disclaw/` default | `./disclaw.yaml` (CWD) |
| `snapshots/` directory | `<basename>-snapshot.json` single file |

These are breaking changes to the CLI interface. Bump minor version.

---

## Future: Multi-Bot Support (Deferred)

### Research Findings

OpenClaw supports multiple Discord bot accounts. Agents are bot-agnostic — an agent can be reused across multiple channels, servers, and bot accounts via match rules with optional `accountId`. The binding model is:

- `agent ↔ many bindings` (via match rules)
- Each binding specifies: channel + optional accountId (bot)
- Trigger gating (`requireMention`, routing allowlists) can differ per path

However, OpenClaw's multi-bot config model (`channels.discord.accounts.<name>.token`) appears to be **emerging, not fully shipped**. The current live config uses a single `channels.discord.token`. The current binding wire format has no `accountId` field — bindings are matched by `agentId:channelId` only. Routing gates (`channels.discord.guilds.<guildId>.channels`) have no per-bot dimension yet.

### Why Defer

1. OpenClaw's multi-bot wire format is not settled — designing against it now risks rework
2. The multi-server design cleanly absorbs multi-bot later (each server block gains a `bots:` section)
3. The dominant use case (multiple servers, one bot) is fully covered by multi-server alone
4. Multi-bot adds stale detection complexity (`agentId:channelId:accountId` keys) that requires OpenClaw schema changes first

### Reserved Config Shape

When OpenClaw ships multi-bot, the config extends naturally from `openclaw.agents:` to `openclaw.bots:`:

**Single bot (current, unchanged):**
```yaml
servers:
  production:
    guild: "111..."
    openclaw:
      requireMention: false
      agents:
        main: general
```

**Multi-bot (future extension):**
```yaml
servers:
  production:
    guild: "111..."
    openclaw:
      bots:
        community-bot:
          account: community
          requireMention: false
          agents:
            main: general
            support:
              channel: tickets
              requireMention: true
        dev-bot:
          account: dev
          agents:
            devops: backend
```

Mental model: **"what does each bot do?"** Each bot section groups its agents and has its own `requireMention` default. The `agents:` shorthand (without `bots:`) means "default/only bot" — zero migration for single-bot users.

### Key Design Decisions (for when we build this)

1. **`allowFrom` is not a Discord concept** — it's WhatsApp/Telegram. Discord uses channel-level allowlisting, which disclaw already manages via routing gates. No new field needed for Discord.

2. **Stale binding detection** must scope to `(channelId + accountId)` — same agent bound to same channel via two bots creates two independent bindings. Removing one must not delete the other.

3. **`addBot: true` semantics** — with multiple bots, this field becomes ambiguous. Options: `addBot: true` (all bots), `addBot: "community-bot"` (specific), `addBot: ["bot-a", "bot-b"]` (list). Decision deferred.

4. **Shared discord.js Client** — multiple bots means multiple `Client` instances (each bot has its own WebSocket connection and token). The provider model extends from `DiscordProvider(client, guildId)` to a provider-per-bot-per-guild.

5. **Routing gates** — unclear if per-bot or shared. Depends on OpenClaw's `accounts` schema. If per-bot: `channels.discord.accounts.<name>.guilds.<guildId>.channels`. If shared: no change.

### Implementation Seams

The multi-server architecture has clean extension points for multi-bot:

- `ServerConfig` gains optional `bots: Record<string, BotConfig>` alongside existing `openclaw`
- Parser detects `openclaw.bots` vs `openclaw.agents` by shape (same pattern as `guild:` vs `servers:`)
- `FlatDesiredBinding` gains `botAccount?: string`
- Reconciler stale detection key adds accountId dimension
- Provider factory instantiates per-bot `DiscordProvider` instances
- Routing gate sync accepts bot account parameter
