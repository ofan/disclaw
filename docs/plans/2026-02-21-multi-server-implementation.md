# Multi-Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple Discord servers from a single disclaw config file, with CWD-based config resolution and single-file snapshots.

**Architecture:** Extend v1 schema by shape detection (`guild:` = single-server, `servers:` = multi-server). Parser normalizes both forms to `ParsedConfig.servers` map. Commands iterate servers, reconciling each independently. Snapshot evolves to multi-server single-file format.

**Tech Stack:** TypeScript, Zod, node:test, discord.js, yaml

**Design doc:** `docs/plans/2026-02-21-multi-server-design.md`

---

## Dependency Graph

```
Task 1 (types) ──┬── Task 3 (parser) ──┬── Task 6 (diff cmd)
                  │                     ├── Task 7 (validate cmd)
                  ├── Task 4 (snapshot) ├── Task 8 (apply cmd)
                  │                     ├── Task 9 (rollback cmd)
Task 2 (recon) ───┤                     └── Task 10 (import cmd)
                  │
Task 5 (CLI) ─────┘                     Task 11 (docs)
```

Tasks 1-5 are foundation (mostly sequential). Tasks 6-10 are commands (parallelizable after foundation). Task 11 is cleanup.

**Team assignment suggestion:**
- Agent A: Tasks 1, 3, 5 (types → parser → CLI — the config pipeline)
- Agent B: Tasks 2, 4 (reconciler guard → snapshot rewrite)
- Agent C: Tasks 6, 7 (diff + validate commands)
- Agent D: Tasks 8, 9 (apply + rollback commands)
- Agent E: Task 10 (import — largest single task)
- After all: Task 11 (docs update)

---

## Task 1: Types Foundation

**Files:**
- Modify: `src/types.ts`

**What changes:**
- Add `ServerConfig` type (per-server config block)
- Add `ParsedConfig` type (normalized multi-server config)
- Evolve `Snapshot` type for multi-server (`servers: Record<string, { guildId, discord }>`)
- Replace `DirOptions` / `resolveDirOptions()` with `resolveConfigPath()` and `resolveSnapshotOptions()`
- Remove `DISCLAW_DIR` references
- Keep `DesiredState` as-is (it represents a single server's desired state internally)

**Step 1: Add new types**

Add after `DesiredState`:

```ts
export interface ServerConfig {
  guild: string;
  channels: DesiredChannelEntry[];
  openclaw?: DesiredOpenClaw;
  warnings?: string[];
}

export interface ParsedConfig {
  servers: Record<string, ServerConfig>;
  singleServer: boolean;
  warnings?: string[];
}

export interface MultiServerSnapshot {
  timestamp: string;
  configHash: string;
  servers: Record<string, { guildId: string; discord: DiscordState }>;
  openclaw: OpenClawState;
}
```

**Step 2: Replace DirOptions with new resolution functions**

Remove `DirOptions`, `resolveDirOptions()`. Add:

```ts
export function resolveConfigPath(opts: { config?: string }): string {
  if (opts.config) return opts.config;
  const envPath = process.env.DISCLAW_CONFIG;
  if (envPath) return envPath;
  return join(process.cwd(), "disclaw.yaml");
}

export interface SnapshotOptions {
  enabled: boolean;
  path: string;
}

export function resolveSnapshotOptions(opts: {
  snapshot?: string;
  noSnapshot?: boolean;
  configPath: string;
}): SnapshotOptions {
  if (opts.noSnapshot) return { enabled: false, path: "" };
  const envVal = process.env.DISCLAW_SNAPSHOT;
  if (envVal && ["off", "false", "0"].includes(envVal.toLowerCase())) {
    return { enabled: false, path: "" };
  }
  if (envVal) return { enabled: true, path: envVal };
  if (opts.snapshot) return { enabled: true, path: opts.snapshot };
  return { enabled: true, path: resolveSnapshotPath(opts.configPath) };
}

export function resolveSnapshotPath(configPath: string): string {
  const dir = dirname(configPath);
  const ext = extname(configPath);
  const base = basename(configPath, ext);
  const slugified = base.replace(/\./g, "-");
  return join(dir, `${slugified}-snapshot.json`);
}
```

Add imports: `basename`, `dirname`, `extname` from `node:path`.

**Step 3: Write tests**

Test file: `src/types.test.ts` (new file)

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfigPath, resolveSnapshotPath, resolveSnapshotOptions } from "./types.ts";

describe("resolveConfigPath", () => {
  it("uses -c flag when provided", () => {
    assert.equal(resolveConfigPath({ config: "/tmp/my.yaml" }), "/tmp/my.yaml");
  });

  it("falls back to CWD/disclaw.yaml", () => {
    const result = resolveConfigPath({});
    assert.ok(result.endsWith("disclaw.yaml"));
  });
});

describe("resolveSnapshotPath", () => {
  it("derives from config basename", () => {
    assert.equal(resolveSnapshotPath("/app/disclaw.yaml"), "/app/disclaw-snapshot.json");
  });

  it("slugifies dots in basename", () => {
    assert.equal(resolveSnapshotPath("/app/my.prod.yaml"), "/app/my-prod-snapshot.json");
  });
});

describe("resolveSnapshotOptions", () => {
  it("disables with --no-snapshot", () => {
    const result = resolveSnapshotOptions({ noSnapshot: true, configPath: "x.yaml" });
    assert.equal(result.enabled, false);
  });

  it("uses custom path from --snapshot", () => {
    const result = resolveSnapshotOptions({ snapshot: "/tmp/s.json", configPath: "x.yaml" });
    assert.equal(result.enabled, true);
    assert.equal(result.path, "/tmp/s.json");
  });

  it("derives default path from config", () => {
    const result = resolveSnapshotOptions({ configPath: "/app/disclaw.yaml" });
    assert.equal(result.enabled, true);
    assert.equal(result.path, "/app/disclaw-snapshot.json");
  });
});
```

**Step 4: Run tests**

```bash
node --test --experimental-strip-types src/types.test.ts
```

**Step 5: Run full test suite to check for regressions**

```bash
npm run test
```

Existing tests using `DirOptions`/`resolveDirOptions` will break. That's expected — those call sites update in later tasks (CLI, commands). For now, keep the old functions alongside the new ones (remove in Task 5 when CLI migrates).

**Step 6: Commit**

```bash
git add src/types.ts src/types.test.ts
git commit -m "feat: add multi-server types and config resolution functions"
```

---

## Task 2: Reconciler — Stale Binding Scoping Guard

**Files:**
- Modify: `src/reconciler.ts` (~3 lines)
- Modify: `src/reconciler.test.ts` (new test case)

**Why:** When reconciling Guild A, stale binding detection sees ALL OpenClaw bindings including Guild B's. Without this guard, Guild B's channels would be flagged as stale deletes.

**Step 1: Write the failing test**

Add to `src/reconciler.test.ts`:

```ts
it("does not flag bindings for channels outside this guild as stale", () => {
  // Guild A has channel "homelab" (id: ch1)
  // OpenClaw has a binding for agent "other-agent" → channel "ch99" (Guild B's channel)
  const discordState: DiscordState = {
    categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
    channels: [
      { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1", managedBy: "disclaw" },
    ],
    threads: [],
    pins: [],
  };
  const openclawState: OpenClawState = {
    bindings: [
      // This guild's binding — expected
      { agentId: "main", match: { channel: "discord", peer: { kind: "channel", id: "ch1" } } },
      // Other guild's binding — must NOT be flagged as stale
      { agentId: "other-agent", match: { channel: "discord", peer: { kind: "channel", id: "ch99" } } },
    ],
  };
  const { actions } = reconcile(desired, discordState, openclawState);
  const deletes = actions.filter((a) => a.type === "delete" && a.resourceType === "binding");
  // "other-agent → ch99" should NOT appear as a delete
  assert.ok(!deletes.some((a) => a.name.includes("other-agent")));
});
```

**Step 2: Run test — confirm it fails**

```bash
node --test --experimental-strip-types src/reconciler.test.ts
```

Expected: FAIL — `other-agent → ch99` appears as a stale delete.

**Step 3: Add the scoping guard**

In `src/reconciler.ts`, in the stale binding detection loop (around line 239-260), add a guard after the `filter((b) => b.match.channel === "discord")`:

```ts
  for (const binding of [...openclaw.bindings]
    .filter((b) => b.match.channel === "discord")
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
  ) {
    // Skip bindings for channels not in this guild's channel list
    const isThisGuild = discord.channels.some((c) => c.id === binding.match.peer.id);
    if (!isThisGuild) continue;

    const key = `${binding.agentId}:${binding.match.peer.id}`;
    // ... rest unchanged
```

**Step 4: Run tests — confirm pass**

```bash
node --test --experimental-strip-types src/reconciler.test.ts
```

**Step 5: Commit**

```bash
git add src/reconciler.ts src/reconciler.test.ts
git commit -m "fix: scope stale binding detection to current guild's channels"
```

---

## Task 3: Parser — Multi-Server Schema and Shape Detection

**Files:**
- Modify: `src/parser.ts`
- Modify: `src/parser.test.ts`

**What changes:**
- Add `ServerConfigSchema` Zod schema
- Add `MultiServerSchema` Zod schema (with `servers:` map)
- `parseConfig()` detects shape (`guild:` vs `servers:`) and returns `ParsedConfig`
- `validateDesiredState()` runs per-server
- `flattenDesiredState()` unchanged (it works on `DesiredState` which is a single server)
- Return type of `parseConfig()` changes from `DesiredState` to `ParsedConfig`

**Step 1: Write the failing tests**

Add to `src/parser.test.ts`:

```ts
describe("parseConfig multi-server", () => {
  it("parses single-server form (guild:) into ParsedConfig", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
`;
    const result = parseConfig(yaml);
    assert.equal(result.singleServer, true);
    assert.ok(result.servers.default);
    assert.equal(result.servers.default.guild, "123");
    assert.equal(result.servers.default.channels.length, 1);
  });

  it("parses multi-server form (servers:)", () => {
    const yaml = `
version: 1
managedBy: disclaw
servers:
  production:
    guild: "111"
    channels:
      - name: general
  staging:
    guild: "222"
    channels:
      - name: general
`;
    const result = parseConfig(yaml);
    assert.equal(result.singleServer, false);
    assert.equal(Object.keys(result.servers).length, 2);
    assert.equal(result.servers.production.guild, "111");
    assert.equal(result.servers.staging.guild, "222");
  });

  it("rejects config with neither guild nor servers", () => {
    const yaml = `
version: 1
managedBy: disclaw
channels:
  - name: general
`;
    assert.throws(() => parseConfig(yaml), /must have.*guild.*or.*servers/i);
  });

  it("validates per-server: duplicate channel in one server throws", () => {
    const yaml = `
version: 1
managedBy: disclaw
servers:
  prod:
    guild: "111"
    channels:
      - name: general
      - name: general
`;
    assert.throws(() => parseConfig(yaml), /Duplicate channel/);
  });

  it("allows same channel name in different servers", () => {
    const yaml = `
version: 1
managedBy: disclaw
servers:
  prod:
    guild: "111"
    channels:
      - name: general
  staging:
    guild: "222"
    channels:
      - name: general
`;
    const result = parseConfig(yaml);
    assert.equal(Object.keys(result.servers).length, 2);
  });

  it("validates binding refs per-server", () => {
    const yaml = `
version: 1
managedBy: disclaw
servers:
  prod:
    guild: "111"
    channels:
      - name: general
    openclaw:
      agents:
        main: missing-channel
`;
    assert.throws(() => parseConfig(yaml), /binds to "missing-channel"/);
  });

  it("includes per-server warnings", () => {
    const yaml = `
version: 1
managedBy: disclaw
servers:
  prod:
    guild: "111"
    channels:
      - category: Empty
        channels: []
`;
    const result = parseConfig(yaml);
    assert.ok(result.warnings?.some(w => w.includes("Empty") && w.includes("prod")));
  });
});
```

**Step 2: Run tests — confirm they fail**

```bash
node --test --experimental-strip-types src/parser.test.ts
```

**Step 3: Implement**

In `src/parser.ts`:

1. Add `ServerConfigSchema`:
```ts
const ServerConfigSchema = z.object({
  guild: z.string(),
  channels: z.array(ChannelEntrySchema),
  openclaw: OpenClawSchema.optional(),
});

const MultiServerConfigSchema = z.object({
  version: z.literal(1),
  managedBy: z.literal("disclaw"),
  servers: z.record(z.string(), ServerConfigSchema),
});
```

2. Change `parseConfig()` return type and implementation:

```ts
export function parseConfig(raw: string): ParsedConfig {
  const parsed = parseYaml(raw);

  if (parsed && typeof parsed === "object" && "servers" in parsed) {
    const config = MultiServerConfigSchema.parse(parsed);
    const allWarnings: string[] = [];
    const servers: Record<string, ServerConfig> = {};
    for (const [name, server] of Object.entries(config.servers)) {
      const state: DesiredState = {
        version: 1, managedBy: "disclaw",
        guild: server.guild, channels: server.channels, openclaw: server.openclaw,
      };
      const warnings = validateDesiredState(state);
      servers[name] = { ...server, warnings: warnings.length > 0 ? warnings : undefined };
      for (const w of warnings) allWarnings.push(`${name}: ${w}`);
    }
    return { servers, singleServer: false, warnings: allWarnings.length > 0 ? allWarnings : undefined };
  }

  if (parsed && typeof parsed === "object" && "guild" in parsed) {
    const state = DesiredStateSchema.parse(parsed) as DesiredState;
    const warnings = validateDesiredState(state);
    if (warnings.length > 0) state.warnings = warnings;
    const server: ServerConfig = {
      guild: state.guild, channels: state.channels, openclaw: state.openclaw,
      warnings: state.warnings,
    };
    return { servers: { default: server }, singleServer: true, warnings: state.warnings };
  }

  throw new Error("Config must have either 'guild' (single-server) or 'servers' (multi-server) key");
}
```

3. Import `ParsedConfig` and `ServerConfig` from types.

**Step 4: Fix existing tests**

All existing `parseConfig()` callers expect `DesiredState`. They now get `ParsedConfig`. Update existing tests to access `result.servers.default` or adapt. For example:

```ts
// Before:
const result = parseConfig(yaml);
assert.equal(result.guild, "123");

// After:
const result = parseConfig(yaml);
assert.equal(result.servers.default.guild, "123");
```

**Step 5: Run all tests**

```bash
npm run test
```

Command files (diff.ts, apply.ts, etc.) will break because they call `parseConfig()` and expect `DesiredState`. Those are fixed in Tasks 6-10. For now, ensure parser tests and reconciler tests pass.

**Step 6: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: multi-server schema detection and parsing"
```

---

## Task 4: Snapshot Rewrite — Single-File Model

**Files:**
- Modify: `src/snapshot.ts`
- Modify: `src/snapshot.test.ts`

**What changes:**
- Replace directory-based snapshot with single-file
- `saveSnapshot(snapshot, path)` — overwrites single file
- `loadSnapshot(path)` — reads single file, returns null if missing
- Migration shim: old format (`discord:` top-level) → new format (`servers:` record)
- Remove: `listSnapshots()`, `loadLatestSnapshot()`, `mkdirSync`

**Step 1: Write the new tests**

Replace `src/snapshot.test.ts`:

```ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { saveSnapshot, loadSnapshot } from "./snapshot.ts";
import { rmSync, writeFileSync } from "node:fs";
import type { MultiServerSnapshot } from "./types.ts";

const TEST_FILE = "/tmp/disclaw-test-snapshot.json";

const mockSnapshot: MultiServerSnapshot = {
  timestamp: new Date().toISOString(),
  configHash: "abc123",
  servers: {
    production: {
      guildId: "111",
      discord: { categories: [], channels: [], threads: [], pins: [] },
    },
  },
  openclaw: { bindings: [] },
};

describe("snapshot single-file", () => {
  afterEach(() => {
    rmSync(TEST_FILE, { force: true });
  });

  it("saves and loads a snapshot", () => {
    saveSnapshot(mockSnapshot, TEST_FILE);
    const loaded = loadSnapshot(TEST_FILE);
    assert.ok(loaded);
    assert.equal(loaded.configHash, "abc123");
    assert.ok(loaded.servers.production);
    assert.equal(loaded.servers.production.guildId, "111");
  });

  it("returns null when file does not exist", () => {
    const loaded = loadSnapshot("/tmp/nonexistent-snap.json");
    assert.equal(loaded, null);
  });

  it("overwrites on second save", () => {
    saveSnapshot(mockSnapshot, TEST_FILE);
    saveSnapshot({ ...mockSnapshot, configHash: "def456" }, TEST_FILE);
    const loaded = loadSnapshot(TEST_FILE);
    assert.equal(loaded?.configHash, "def456");
  });

  it("migrates old format (discord: top-level) to new format", () => {
    // Old format: { discord: DiscordState, openclaw: OpenClawState }
    const oldSnapshot = {
      timestamp: "2026-01-01T00:00:00Z",
      configHash: "old",
      discord: { categories: [], channels: [], threads: [], pins: [] },
      openclaw: { bindings: [] },
    };
    writeFileSync(TEST_FILE, JSON.stringify(oldSnapshot));
    const loaded = loadSnapshot(TEST_FILE);
    assert.ok(loaded);
    assert.ok(loaded.servers.default);
    assert.equal(loaded.servers.default.guildId, "unknown");
    assert.deepEqual(loaded.servers.default.discord, oldSnapshot.discord);
  });
});
```

**Step 2: Implement**

Replace `src/snapshot.ts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import type { MultiServerSnapshot } from "./types.ts";

export function saveSnapshot(snapshot: MultiServerSnapshot, path: string): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export function loadSnapshot(path: string): MultiServerSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migration shim: old format has discord: at top level
    if (raw.discord && !raw.servers) {
      return {
        timestamp: raw.timestamp,
        configHash: raw.configHash,
        servers: {
          default: { guildId: "unknown", discord: raw.discord },
        },
        openclaw: raw.openclaw,
      };
    }
    return raw as MultiServerSnapshot;
  } catch {
    return null;
  }
}
```

**Step 3: Run tests**

```bash
node --test --experimental-strip-types src/snapshot.test.ts
```

**Step 4: Commit**

```bash
git add src/snapshot.ts src/snapshot.test.ts
git commit -m "feat: single-file snapshot model with migration shim"
```

---

## Task 5: CLI Entry Point — New Flags and Config Resolution

**Files:**
- Modify: `src/cli.ts`

**What changes:**
- Replace `--dir` with nothing (removed)
- Add `--server` / `-s` flag (all commands except validate)
- Add `--no-snapshot` flag (apply, rollback)
- Add `--snapshot <path>` flag (apply, rollback)
- Use `resolveConfigPath()` instead of `resolveDirOptions()`
- Use `resolveSnapshotOptions()` for snapshot path
- Pass `serverFilter` and snapshot options through to commands
- Remove: `--dir` global option, `DISCLAW_DIR` references

**Step 1: Update CLI**

Each command's action handler changes from:
```ts
const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
```
to:
```ts
const configPath = resolveConfigPath({ config: opts.config });
```

Diff command example:
```ts
const diffCmd = program
  .command("diff")
  .description("Show full diff between config and current state")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-s, --server <name>", "Target a specific server");
addCommonFlags(diffCmd)
  .action(async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await diffCommand(configPath, filter, opts.json, gwOpts, opts.server);
    process.exit(code);
  });
```

Apply and rollback get additional snapshot flags:
```ts
  .option("--no-snapshot", "Skip saving snapshot before apply", false)
  .option("--snapshot <path>", "Custom snapshot file path")
```

And pass snapshot options:
```ts
    const snapOpts = resolveSnapshotOptions({
      snapshot: opts.snapshot,
      noSnapshot: opts.noSnapshot,
      configPath,
    });
```

**Step 2: Run type check**

```bash
npx tsc --noEmit
```

This will show errors in command files (signature changes). Those are fixed in Tasks 6-10.

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: CLI flags for multi-server, snapshot controls, CWD-based config"
```

---

## Task 6: Diff Command — Multi-Server Loop

**Files:**
- Modify: `src/commands/diff.ts`

**What changes:**
- Accept `ParsedConfig` from `parseConfig()` (iterate `servers`)
- Add `serverFilter?: string` parameter
- Per-server output headers: `── production (Discord Name) ──`
- Per-server reconciliation
- JSON output includes `server` field
- Unbound agent warning scoped across all servers

**Step 1: Write tests**

Create `src/commands/diff.test.ts` — test the multi-server output format, `--server` filtering, JSON output with server field. These can be integration-style tests that call `diffCommand()` with mock providers (or test the formatting logic).

**Step 2: Implement**

The command function signature changes:
```ts
export async function diffCommand(
  configPath: string,
  filter: ResourceTypeFilter | null,
  json: boolean,
  gwOpts?: GatewayOptions,
  serverFilter?: string,
): Promise<number>
```

Core loop:
```ts
const config = parseConfig(raw);

if (serverFilter && !config.servers[serverFilter]) {
  const names = Object.keys(config.servers).join(", ");
  console.error(`Error: Server "${serverFilter}" not found. Available: ${names}`);
  return 1;
}

const serverEntries = serverFilter
  ? [[serverFilter, config.servers[serverFilter]] as const]
  : Object.entries(config.servers);

// Shared OpenClaw provider
const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
const ocProvider = resolved?.provider ?? null;
const openclawState = ocProvider ? await ocProvider.fetch() : { bindings: [] };

// Shared Discord client (login once)
const token = await resolveDiscordToken(gwOpts);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);

try {
  for (const [serverName, server] of serverEntries) {
    const discord = new DiscordProvider(client, server.guild);
    const discordState = await discord.fetch();
    // ... reconcile, format, output with per-server header
  }
} finally {
  client.destroy();
}
```

**Step 3: Run tests and verify**

```bash
npm run test
```

**Step 4: Commit**

```bash
git add src/commands/diff.ts src/commands/diff.test.ts
git commit -m "feat: multi-server diff command with per-server output"
```

---

## Task 7: Validate Command — Multi-Server

**Files:**
- Modify: `src/commands/validate.ts`

**What changes:**
- Accept `ParsedConfig` from `parseConfig()`
- Per-server validation output: `✓ production: valid`
- JSON output: `{"valid": true, "servers": ["production", "staging"]}`
- Exit 1 if any server has errors
- No `--server` flag (always validates all)

**Step 1: Implement**

```ts
export function validateCommand(configPath: string, json: boolean = false): number {
  const raw = readFileSync(configPath, "utf-8");
  const config = parseConfig(raw);

  if (json) {
    console.log(JSON.stringify({
      valid: !config.warnings?.length,
      servers: Object.keys(config.servers),
      ...(config.warnings?.length ? { warnings: config.warnings } : {}),
    }));
    return config.warnings?.length ? 1 : 0;
  }

  for (const [name, server] of Object.entries(config.servers)) {
    if (server.warnings?.length) {
      for (const w of server.warnings) console.log(`⚠ ${name}: ${w}`);
    } else {
      console.log(`✓ ${name}: valid`);
    }
  }

  if (config.warnings?.length) {
    console.log(`Config invalid (${config.warnings.length} warning(s))`);
    return 1;
  }

  const serverCount = Object.keys(config.servers).length;
  console.log(`✓ Config valid${serverCount > 1 ? ` (${serverCount} servers)` : ""}`);
  return 0;
}
```

**Step 2: Run tests**

```bash
npm run test
```

**Step 3: Commit**

```bash
git add src/commands/validate.ts
git commit -m "feat: multi-server validate with per-server output"
```

---

## Task 8: Apply Command — Multi-Server with Combined Snapshot

**Files:**
- Modify: `src/commands/apply.ts`

**What changes:**
- Accept `ParsedConfig`, `serverFilter`, `SnapshotOptions`
- Combined snapshot before any mutation (all servers' state)
- Per-server apply loop (serial, fail-fast per server, continue to next)
- Per-server output headers
- `--server` filter support
- Snapshot skipping (`--no-snapshot`)
- JSON output includes `server` field

**Key flow:**
1. Parse config → `ParsedConfig`
2. Login shared Discord client
3. Fetch all servers' Discord state + shared OpenClaw state
4. Save combined snapshot (if enabled)
5. Reconcile + apply per server (serial)
6. Per-server error handling: log error, continue to next, report at end

**Step 1: Write tests** for the multi-server apply flow. Focus on:
- Combined snapshot contains all servers
- `--server` filter only applies to one server
- Per-server failure doesn't block other servers
- `--no-snapshot` skips snapshot

**Step 2: Implement** following the pattern from diff command.

**Step 3: Run tests**

```bash
npm run test
```

**Step 4: Commit**

```bash
git add src/commands/apply.ts
git commit -m "feat: multi-server apply with combined snapshot and per-server failure"
```

---

## Task 9: Rollback Command — Multi-Server Snapshot

**Files:**
- Modify: `src/commands/rollback.ts`

**What changes:**
- Load multi-server snapshot format
- `--server` filter: rollback one or all servers
- `snapshotToDesired()` works per-server (iterate `snapshot.servers`)
- Pre-rollback snapshot saved
- Handle old-format snapshots via migration shim (transparent)

**Step 1: Implement** per-server rollback loop.

**Step 2: Run tests**

```bash
npm run test
```

**Step 3: Commit**

```bash
git add src/commands/rollback.ts
git commit -m "feat: multi-server rollback with per-server scoping"
```

---

## Task 10: Import Command — All-Server Discovery

**Files:**
- Modify: `src/commands/import.ts`

**What changes:**
- When no config exists: discover all bot servers via `client.guilds.fetch()`
- Generate multi-server config with slugified Discord server names
- When config exists + `--server`: import into specific server block
- When config exists, no `--server`: import into all servers + discover new servers
- Write multi-server YAML format (not single-server)

**This is the largest single task.** Key implementation:

1. **No config exists** → bootstrap:
```ts
const guilds = await client.guilds.fetch();
// For each guild: fetch channels, categories, threads, bindings
// Generate ParsedConfig with slugified names
// Write to configPath
```

2. **Config exists** → incremental import (existing behavior, now per-server)

3. **Server name slugification:**
```ts
function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/[^\w\s-]/g, "")  // strip emoji and special chars
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
```

**Step 1: Write tests** for slugification, multi-server config generation, incremental import.

**Step 2: Implement**

**Step 3: Run tests**

```bash
npm run test
```

**Step 4: Commit**

```bash
git add src/commands/import.ts
git commit -m "feat: multi-server import with all-server discovery"
```

---

## Task 11: Documentation and Cleanup

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `skills/disclaw/SKILL.md`
- Remove old `DirOptions`/`resolveDirOptions` from types.ts (if not already done)

**What changes:**
- Update README with multi-server config example
- Update CLAUDE.md with new CLI flags, env vars, removed features
- Update SKILL.md with multi-server config format, new commands, new flags
- Remove any dead code from migration

**Step 1: Update docs**

**Step 2: Run full test suite**

```bash
npm run test && npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add README.md CLAUDE.md skills/disclaw/SKILL.md src/types.ts
git commit -m "docs: update for multi-server support"
```

---

## Test Coverage Checklist

Each task should ensure these scenarios are tested:

### Parser tests
- [ ] Single-server form (`guild:`) parses to `ParsedConfig` with `singleServer: true`
- [ ] Multi-server form (`servers:`) parses to `ParsedConfig` with `singleServer: false`
- [ ] Missing both `guild:` and `servers:` throws
- [ ] Duplicate channel name within one server throws
- [ ] Same channel name in different servers is OK
- [ ] Binding ref to non-existent channel (per-server) throws
- [ ] Per-server warnings (empty category)
- [ ] OpenClaw agents per-server (all 4 binding forms)

### Reconciler tests
- [ ] Bindings for other guild's channels not flagged as stale
- [ ] Bindings for this guild's channels still flagged as stale when not in config
- [ ] Existing tests still pass (no regression)

### Snapshot tests
- [ ] Save and load single-file snapshot
- [ ] Overwrite on second save
- [ ] Return null when file missing
- [ ] Migrate old format (discord: top-level) to new format
- [ ] Multi-server snapshot contains all servers
- [ ] resolveSnapshotPath derivation (basename, slugify dots)
- [ ] --no-snapshot / DISCLAW_SNAPSHOT=off disables

### Command tests
- [ ] diff: multi-server output grouped by server
- [ ] diff: --server filters to one server
- [ ] diff: unknown server name errors with available list
- [ ] validate: per-server output, JSON includes server list
- [ ] apply: combined snapshot before mutation
- [ ] apply: per-server failure doesn't block others
- [ ] apply: --server applies only to one
- [ ] rollback: loads multi-server snapshot
- [ ] rollback: --server rolls back one only
- [ ] import: discovers all bot servers when no config exists
- [ ] import: slugifies Discord server names
