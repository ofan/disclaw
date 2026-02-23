# Telemetry Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-out telemetry to disclaw that sends command lifecycle events to the telemetry-relay CF Worker, using the `telemetry-relay-sdk` client package.

**Architecture:** Single module `src/telemetry.ts` with `withTelemetry()` wrapper. Uses `createRelay()` from `telemetry-relay-sdk` for HTTP transport. Wraps each command's `.action()` in `cli.ts`. One new dependency.

**Tech Stack:** `telemetry-relay-sdk` (transport), `node:crypto` (machine ID), `node:os` (hostname, platform)

**Design doc:** `docs/plans/2026-02-23-telemetry-client-design.md`

**SDK source:** `~/projects/telemetry-relay/sdk/` — exports `createRelay({ url, token })` returning `{ track(tool, event, version, properties) }`

---

### Task 1: Install SDK + telemetry module with opt-out

**Files:**
- Create: `src/telemetry.ts`
- Create: `src/telemetry.test.ts`

**Step 1: Install telemetry-relay-sdk**

Link locally for development (switch to npm registry after publish):

```bash
cd ~/projects/telemetry-relay/sdk && npm install && npm run build
cd ~/projects/disclaw && npm install ~/projects/telemetry-relay/sdk
```

**Step 2: Write the failing test**

```ts
// src/telemetry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEnabled } from "./telemetry.ts";

describe("isEnabled", () => {
  it("returns true by default", () => {
    const prev = process.env.DISCLAW_TELEMETRY;
    delete process.env.DISCLAW_TELEMETRY;
    try {
      assert.equal(isEnabled(), true);
    } finally {
      if (prev !== undefined) process.env.DISCLAW_TELEMETRY = prev;
    }
  });

  it("returns false when DISCLAW_TELEMETRY=0", () => {
    const prev = process.env.DISCLAW_TELEMETRY;
    process.env.DISCLAW_TELEMETRY = "0";
    try {
      assert.equal(isEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.DISCLAW_TELEMETRY = prev;
      else delete process.env.DISCLAW_TELEMETRY;
    }
  });

  it("returns false for 'false' and 'off'", () => {
    for (const val of ["false", "off"]) {
      process.env.DISCLAW_TELEMETRY = val;
      assert.equal(isEnabled(), false, `expected false for '${val}'`);
    }
    delete process.env.DISCLAW_TELEMETRY;
  });
});
```

**Step 3: Run test to verify it fails**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: FAIL — module not found

**Step 4: Write minimal implementation**

```ts
// src/telemetry.ts
const DISABLED_VALUES = new Set(["0", "false", "off"]);

export function isEnabled(): boolean {
  const val = process.env.DISCLAW_TELEMETRY;
  if (val !== undefined && DISABLED_VALUES.has(val.toLowerCase())) return false;
  return true;
}
```

**Step 5: Run test to verify it passes**

Run: `node --test --experimental-strip-types src/telemetry.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts package.json package-lock.json
git commit -m "feat(telemetry): add isEnabled with opt-out, install telemetry-relay-sdk"
```

---

### Task 2: Machine ID generation

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
import { isEnabled, getMachineId } from "./telemetry.ts";

describe("getMachineId", () => {
  it("returns a 16-char hex string", () => {
    const id = getMachineId();
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("returns stable value across calls", () => {
    assert.equal(getMachineId(), getMachineId());
  });
});
```

**Step 2: Run test — FAIL**

**Step 3: Implement**

Add to `src/telemetry.ts`:

```ts
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

let cachedMachineId: string | undefined;

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const raw = hostname() + userInfo().username;
  cachedMachineId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cachedMachineId;
}
```

**Step 4: Run test — PASS**

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add getMachineId (SHA-256 of hostname+username)"
```

---

### Task 3: track() + flush() using SDK relay

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing tests**

```ts
import { isEnabled, getMachineId, track, flush } from "./telemetry.ts";

describe("track + flush", () => {
  it("sends event via SDK relay on flush", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const calls: { url: string; init: RequestInit }[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "test" }), { status: 202 });
    }) as typeof fetch;

    try {
      track("command_run", { command: "diff" });
      await flush();
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.includes("/v1/events"));
      const body = JSON.parse(calls[0].init.body as string);
      assert.equal(body.tool, "disclaw");
      assert.equal(body.event, "command_run");
      assert.ok(body.properties.command === "diff");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("is noop when disabled", async () => {
    process.env.DISCLAW_TELEMETRY = "0";
    const origFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("ok"); }) as typeof fetch;
    try {
      track("command_run", {});
      await flush();
      assert.equal(called, false);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.DISCLAW_TELEMETRY;
    }
  });

  it("swallows errors silently", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("boom"); }) as typeof fetch;
    try {
      track("command_run", {});
      await flush(); // must not throw
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
```

**Step 2: Run test — FAIL**

**Step 3: Implement**

Add to `src/telemetry.ts`:

```ts
import { platform } from "node:os";
import { createRelay, type Relay } from "telemetry-relay-sdk";
import { VERSION } from "./version.ts";

const RELAY_URL = process.env.DISCLAW_TELEMETRY_URL ?? "https://telemetry-relay.<subdomain>.workers.dev";
const RELAY_TOKEN = process.env.DISCLAW_TELEMETRY_TOKEN ?? "<default-ingest-token>";

let relay: Relay | undefined;

function getRelay(): Relay {
  if (!relay) relay = createRelay({ url: RELAY_URL, token: RELAY_TOKEN });
  return relay;
}

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
}

const queue: QueuedEvent[] = [];

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!isEnabled()) return;
  queue.push({
    event,
    properties: {
      ...properties,
      os: platform(),
      nodeVersion: process.version,
      ci: process.env.CI === "true",
    },
  });
}

export async function flush(): Promise<void> {
  if (!isEnabled() || queue.length === 0) return;
  const events = queue.splice(0);
  const r = getRelay();
  const machineId = getMachineId();
  try {
    await Promise.all(
      events.map((e) =>
        r.track("disclaw", e.event, VERSION, { ...e.properties, machineId }),
      ),
    );
  } catch {
    // Telemetry must never break the CLI
  }
}
```

Note: `RELAY_URL` and `RELAY_TOKEN` defaults updated to real values after deploying. Tests mock `fetch` so actual URL doesn't matter.

**Step 4: Run test — PASS**

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add track() + flush() using telemetry-relay-sdk"
```

---

### Task 4: withTelemetry() wrapper

**Files:**
- Modify: `src/telemetry.ts`
- Modify: `src/telemetry.test.ts`

**Step 1: Write the failing test**

```ts
import { isEnabled, getMachineId, track, flush, withTelemetry } from "./telemetry.ts";

describe("withTelemetry", () => {
  it("tracks command_run + command_done with timing", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    const bodies: Record<string, unknown>[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify({ id: "x" }), { status: 202 });
    }) as typeof fetch;

    try {
      const wrapped = withTelemetry("diff", async () => 0);
      const code = await wrapped({ json: false, filters: "channel" });
      assert.equal(code, 0);
      // 2 track calls = 2 fetch calls (SDK sends individually)
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].event, "command_run");
      assert.equal((bodies[0].properties as Record<string, unknown>).command, "diff");
      assert.equal(bodies[1].event, "command_done");
      assert.equal((bodies[1].properties as Record<string, unknown>).exitCode, 0);
      assert.ok(typeof (bodies[1].properties as Record<string, unknown>).durationMs === "number");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns exit code even when disabled", async () => {
    process.env.DISCLAW_TELEMETRY = "0";
    const wrapped = withTelemetry("validate", async () => 42);
    assert.equal(await wrapped({}), 42);
    delete process.env.DISCLAW_TELEMETRY;
  });
});
```

**Step 2: Run test — FAIL**

**Step 3: Implement**

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

**Step 4: Run test — PASS**

**Step 5: Commit**

```bash
git add src/telemetry.ts src/telemetry.test.ts
git commit -m "feat(telemetry): add withTelemetry() command wrapper"
```

---

### Task 5: Integrate into cli.ts

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add import and --no-telemetry flag**

Add import at top of `src/cli.ts`:

```ts
import { withTelemetry } from "./telemetry.ts";
```

Add `--no-telemetry` root option (after `--gateway-token`):

```ts
  .option("--no-telemetry", "Disable anonymous telemetry");
```

Add preAction hook (after program definition, before commands):

```ts
program.hook("preAction", (thisCommand) => {
  const root = thisCommand.optsWithGlobals();
  if (root.telemetry === false) {
    process.env.DISCLAW_TELEMETRY = "0";
  }
});
```

**Step 2: Add run() helper**

After `addCommonFlags`:

```ts
function run(name: string, fn: (opts: Record<string, unknown>) => Promise<number>) {
  return withTelemetry(name, async (opts) => {
    const code = await fn(opts);
    process.exit(code);
    return code;
  });
}
```

**Step 3: Wrap all 5 commands**

Replace each `.action(async (opts) => { ... process.exit(code); })` with `.action(run("name", async (opts) => { ... return code; }))`.

The command body stays the same — just change `process.exit(code)` to `return code` and wrap with `run()`.

For validate (sync command), wrap in async: `run("validate", async (opts) => { ... return code; })`.

**Step 4: Run all tests**

Run: `node --test --experimental-strip-types src/*.test.ts src/**/*.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(telemetry): integrate withTelemetry wrapper into all CLI commands"
```

---

### Task 6: Verify + docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Full test run**

Run: `node --test --experimental-strip-types src/*.test.ts src/**/*.test.ts`
Expected: All PASS

**Step 3: Smoke test**

```bash
npm run disclaw -- validate
DISCLAW_TELEMETRY=0 npm run disclaw -- validate
npm run disclaw -- --no-telemetry validate
```

Expected: All three work. First may have ~1s delay (flush timeout).

**Step 4: Add telemetry section to CLAUDE.md**

After "Snapshot Options":

```markdown
## Telemetry
- Opt-out: `DISCLAW_TELEMETRY=0` or `--no-telemetry`
- Events: `command_run` + `command_done` (lifecycle only)
- Relay: telemetry-relay CF Worker (separate repo at `~/projects/telemetry-relay`)
- SDK: `telemetry-relay-sdk` (from `~/projects/telemetry-relay/sdk/`)
- Override: `DISCLAW_TELEMETRY_URL`, `DISCLAW_TELEMETRY_TOKEN`
- Implementation: `src/telemetry.ts` — `withTelemetry()` wraps command actions in `cli.ts`
```

**Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add telemetry section to CLAUDE.md"
```
