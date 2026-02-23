# Telemetry Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-out telemetry to disclaw that sends command lifecycle events to the telemetry-relay CF Worker.

**Architecture:** Single module `src/telemetry.ts` with `withTelemetry()` wrapper. Wraps each command's `.action()` in `cli.ts`. Events queued in-memory, batch-flushed before `process.exit()`. No new dependencies.

**Tech Stack:** `node:crypto` (machine ID hash), `node:os` (hostname, platform), native `fetch` (HTTP POST)

**Design doc:** `docs/plans/2026-02-23-telemetry-client-design.md`

---

### Task 1: Telemetry module — core + opt-out

**Files:**
- Create: `src/telemetry.ts`
- Create: `src/telemetry.test.ts`

**Step 1: Write the failing test for isEnabled**

```ts
// src/telemetry.test.ts
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("telemetry", () => {
  let telemetry: typeof import("./telemetry.ts");

  // Fresh module import per test to reset state
  beforeEach(async () => {
    telemetry = await import(`./telemetry.ts?t=${Date.now()}`);
  });

  describe("isEnabled", () => {
    it("returns true by default", () => {
      delete process.env.DISCLAW_TELEMETRY;
      assert.equal(telemetry.isEnabled(), true);
    });

    it("returns false when DISCLAW_TELEMETRY=0", () => {
      process.env.DISCLAW_TELEMETRY = "0";
      assert.equal(telemetry.isEnabled(), false);
    });

    it("returns false when DISCLAW_TELEMETRY=false", () => {
      process.env.DISCLAW_TELEMETRY = "false";
      assert.equal(telemetry.isEnabled(), false);
    });

    it("returns false when DISCLAW_TELEMETRY=off", () => {
      process.env.DISCLAW_TELEMETRY = "off";
      assert.equal(telemetry.isEnabled(), false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
// src/telemetry.ts
const DISABLED_VALUES = new Set(["0", "false", "off"]);

export function isEnabled(): boolean {
  const val = process.env.DISCLAW_TELEMETRY;
  if (val !== undefined && DISABLED_VALUES.has(val.toLowerCase())) return false;
  return true;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add isEnabled with opt-out via DISCLAW_TELEMETRY env var"
```

---

### Task 2: Machine ID generation

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
describe("getMachineId", () => {
  it("returns a 16-char hex string", () => {
    const id = telemetry.getMachineId();
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("returns the same value on repeated calls", () => {
    assert.equal(telemetry.getMachineId(), telemetry.getMachineId());
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — getMachineId not exported

**Step 3: Write minimal implementation**

Add to `src/telemetry.ts`:

```ts
import { createHash } from "node:crypto";
import { hostname, userInfo, platform, release } from "node:os";

let cachedMachineId: string | undefined;

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const raw = hostname() + userInfo().username;
  cachedMachineId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cachedMachineId;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add getMachineId (SHA-256 hash of hostname+username)"
```

---

### Task 3: Event queue and track()

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
describe("track", () => {
  it("queues an event", () => {
    delete process.env.DISCLAW_TELEMETRY;
    telemetry.track("command_run", { command: "diff" });
    const queued = telemetry.getQueue();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].event, "command_run");
    assert.equal(queued[0].tool, "disclaw");
    assert.ok(queued[0].machineId);
    assert.ok(queued[0].version);
  });

  it("is a noop when disabled", () => {
    process.env.DISCLAW_TELEMETRY = "0";
    telemetry.track("command_run", { command: "diff" });
    assert.equal(telemetry.getQueue().length, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — track/getQueue not exported

**Step 3: Write minimal implementation**

Add to `src/telemetry.ts`:

```ts
import { VERSION } from "./version.ts";

interface TelemetryEvent {
  tool: string;
  event: string;
  version: string;
  machineId: string;
  properties: Record<string, unknown>;
}

const queue: TelemetryEvent[] = [];

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!isEnabled()) return;
  queue.push({
    tool: "disclaw",
    event,
    version: VERSION,
    machineId: getMachineId(),
    properties: {
      ...properties,
      os: platform(),
      nodeVersion: process.version,
      ci: process.env.CI === "true",
    },
  });
}

/** Exposed for testing only */
export function getQueue(): readonly TelemetryEvent[] {
  return queue;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add track() with event queue"
```

---

### Task 4: flush() — batch POST with timeout

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
describe("flush", () => {
  it("sends batch POST to relay and clears queue", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const calls: { url: string; init: RequestInit }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 202 });
    }) as typeof fetch;

    try {
      telemetry.track("command_run", { command: "diff" });
      await telemetry.flush();
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes("/v1/events/batch"));
      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.events.length, 1);
      assert.equal(telemetry.getQueue().length, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("does nothing when queue is empty", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const calls: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls.push(1);
      return new Response("ok");
    }) as typeof fetch;

    try {
      await telemetry.flush();
      assert.equal(calls.length, 0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("swallows fetch errors silently", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as typeof fetch;

    try {
      telemetry.track("command_run", {});
      await telemetry.flush(); // should not throw
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — flush not exported

**Step 3: Write minimal implementation**

Add to `src/telemetry.ts`:

```ts
const RELAY_URL = process.env.DISCLAW_TELEMETRY_URL ?? "https://telemetry-relay.<subdomain>.workers.dev";
const RELAY_TOKEN = process.env.DISCLAW_TELEMETRY_TOKEN ?? "<default-ingest-token>";
const FLUSH_TIMEOUT_MS = 1000;

export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const events = queue.splice(0);
  try {
    await fetch(`${RELAY_URL}/v1/events/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RELAY_TOKEN}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
    });
  } catch {
    // Telemetry must never break the CLI
  }
}
```

Note: The `RELAY_URL` and `RELAY_TOKEN` defaults will be updated to real values after deploying telemetry-relay. For now, tests override `fetch` so the actual URL doesn't matter.

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add flush() with batch POST and 1s timeout"
```

---

### Task 5: withTelemetry() wrapper

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
describe("withTelemetry", () => {
  it("tracks command_run and command_done with timing", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const flushed: TelemetryEvent[][] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      flushed.push(JSON.parse(init.body as string).events);
      return new Response("ok", { status: 202 });
    }) as typeof fetch;

    try {
      const wrapped = telemetry.withTelemetry("diff", async () => 0);
      const exitCode = await wrapped({ json: false, filters: "channel" });
      assert.equal(exitCode, 0);
      assert.equal(flushed.length, 1);
      const events = flushed[0];
      assert.equal(events.length, 2);
      assert.equal(events[0].event, "command_run");
      assert.equal(events[0].properties.command, "diff");
      assert.equal(events[1].event, "command_done");
      assert.equal(events[1].properties.command, "diff");
      assert.equal(events[1].properties.exitCode, 0);
      assert.ok(typeof events[1].properties.durationMs === "number");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("captures non-zero exit codes", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const flushed: TelemetryEvent[][] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      flushed.push(JSON.parse(init.body as string).events);
      return new Response("ok", { status: 202 });
    }) as typeof fetch;

    try {
      const wrapped = telemetry.withTelemetry("apply", async () => 1);
      const exitCode = await wrapped({});
      assert.equal(exitCode, 1);
      const done = flushed[0][1];
      assert.equal(done.properties.exitCode, 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("still returns exit code when telemetry disabled", async () => {
    process.env.DISCLAW_TELEMETRY = "0";
    const wrapped = telemetry.withTelemetry("validate", async () => 0);
    const exitCode = await wrapped({});
    assert.equal(exitCode, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — withTelemetry not exported

**Step 3: Write minimal implementation**

Add to `src/telemetry.ts`:

```ts
type CommandOpts = Record<string, unknown>;

export function withTelemetry(
  commandName: string,
  fn: (opts: CommandOpts) => Promise<number>,
): (opts: CommandOpts) => Promise<number> {
  return async (opts) => {
    const commonProps = {
      command: commandName,
      json: Boolean(opts.json),
      filters: opts.filters ?? null,
      server: opts.server ?? null,
    };
    track("command_run", commonProps);
    const start = performance.now();
    const exitCode = await fn(opts);
    const durationMs = Math.round(performance.now() - start);
    track("command_done", { ...commonProps, exitCode, durationMs });
    await flush();
    return exitCode;
  };
}
```

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add withTelemetry() command wrapper"
```

---

### Task 6: Integrate into cli.ts

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add --no-telemetry flag and import**

At the top of `src/cli.ts`, add the import:

```ts
import { withTelemetry } from "./telemetry.ts";
```

Add `--no-telemetry` as a root-level option (after the `--gateway-token` line):

```ts
  .option("--no-telemetry", "Disable anonymous telemetry");
```

Add the opt-out wiring right after `program` definition (before command registration):

```ts
// Wire --no-telemetry flag to env var (checked by telemetry module)
const rootOpts = program.opts();
if (rootOpts.telemetry === false) {
  process.env.DISCLAW_TELEMETRY = "0";
}
```

Wait — commander doesn't parse opts until `.parse()` is called. Instead, handle this at the start of each action by checking the parent opts. Actually, the simplest approach: use a `program.hook("preAction")` to set the env var before any command runs:

```ts
program.hook("preAction", (thisCommand) => {
  const root = thisCommand.optsWithGlobals();
  if (root.telemetry === false) {
    process.env.DISCLAW_TELEMETRY = "0";
  }
});
```

**Step 2: Wrap each command action with withTelemetry**

Replace the `.action()` bodies. The pattern for each command:

**diff** (line 33–40):
```ts
  .action(withTelemetry("diff", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config as string | undefined });
    const filter = parseTypeFilter(opts.filters as string | undefined);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    return await diffCommand(configPath, filter, Boolean(opts.json), gwOpts, opts.server as string | undefined);
  }));
```

**apply** (line 52–64):
```ts
  .action(withTelemetry("apply", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config as string | undefined });
    const filter = parseTypeFilter(opts.filters as string | undefined);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const snapOpts = resolveSnapshotOptions({
      snapshot: typeof opts.snapshot === "string" ? opts.snapshot : undefined,
      noSnapshot: opts.snapshot === false,
      configPath,
    });
    return await applyCommand(configPath, Boolean(opts.yes), filter, Boolean(opts.json), Boolean(opts.prune), gwOpts, snapOpts, opts.server as string | undefined);
  }));
```

**rollback** (line 75–86):
```ts
  .action(withTelemetry("rollback", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config as string | undefined });
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const snapOpts = resolveSnapshotOptions({
      snapshot: typeof opts.snapshot === "string" ? opts.snapshot : undefined,
      noSnapshot: opts.snapshot === false,
      configPath,
    });
    return await rollbackCommand(configPath, Boolean(opts.yes), Boolean(opts.json), gwOpts, snapOpts, opts.server as string | undefined);
  }));
```

**import** (line 95–102):
```ts
  .action(withTelemetry("import", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config as string | undefined });
    const filter = parseTypeFilter(opts.filters as string | undefined);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    return await importCommand(configPath, Boolean(opts.yes), filter, Boolean(opts.json), gwOpts, opts.server as string | undefined);
  }));
```

**validate** (line 109–126) — note this is sync, so wrap in async:
```ts
  .action(withTelemetry("validate", async (opts) => {
    try {
      const configPath = resolveConfigPath({ config: opts.config as string | undefined });
      if (!opts.json) console.log(`Config: ${configPath}`);
      return validateCommand(configPath, Boolean(opts.json));
    } catch (err: unknown) {
      if (opts.json) {
        console.log(JSON.stringify({
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 1;
    }
  }));
```

Key change: commands now `return` exit codes instead of calling `process.exit()` directly. The `withTelemetry` wrapper will flush then the outer `.action()` handler calls `process.exit()`.

Wait — actually `withTelemetry` returns the exit code, and commander doesn't call `process.exit`. We need to keep `process.exit`. Update the approach: make `withTelemetry` call `process.exit` itself after flushing.

Better: add a thin wrapper in cli.ts:

```ts
function run(commandName: string, fn: (opts: Record<string, unknown>) => Promise<number>) {
  return withTelemetry(commandName, async (opts) => {
    const code = await fn(opts);
    process.exit(code);
    return code; // unreachable but satisfies types
  });
}
```

Then use `run("diff", async (opts) => { ... })` for each command.

**Step 3: Run existing tests**

Run: `node --test --experimental-strip-types src/*.test.ts src/**/*.test.ts`
Expected: All existing tests PASS (no behavioral change)

**Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(telemetry): integrate withTelemetry wrapper into all CLI commands"
```

---

### Task 7: Type check + full test run

**Files:** None — verification only

**Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `node --test --experimental-strip-types src/*.test.ts src/**/*.test.ts`
Expected: All tests PASS including new telemetry tests

**Step 3: Manual smoke test**

```bash
# Telemetry enabled (default) — should not error even though relay is not running
npm run disclaw -- validate

# Telemetry disabled
DISCLAW_TELEMETRY=0 npm run disclaw -- validate

# Telemetry disabled via flag
npm run disclaw -- --no-telemetry validate
```

Expected: All three work identically. The first may show a brief delay (~1s) as flush times out since no relay is running.

**Step 4: Commit (if any fixes needed)**

---

### Task 8: Update CLAUDE.md and docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add telemetry section to CLAUDE.md**

Add after the "Snapshot Options" section:

```markdown
## Telemetry
- Opt-out: `DISCLAW_TELEMETRY=0` or `--no-telemetry`
- Events: `command_run` + `command_done` (lifecycle only)
- Relay: telemetry-relay CF Worker (separate repo)
- Override URL: `DISCLAW_TELEMETRY_URL`, `DISCLAW_TELEMETRY_TOKEN`
- Implementation: `src/telemetry.ts` — `withTelemetry()` wraps command actions in `cli.ts`
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add telemetry section to CLAUDE.md"
```
