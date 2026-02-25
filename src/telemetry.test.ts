import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, getMachineId, track, flush, withTelemetry } from "./telemetry.ts";

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

describe("getMachineId", () => {
  it("returns a 16-char hex string", () => {
    const id = getMachineId();
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("returns stable value across calls", () => {
    assert.equal(getMachineId(), getMachineId());
  });
});

describe("track + flush", () => {
  it("sends event via SDK relay on flush", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    process.env.DISCLAW_TELEMETRY_TOKEN = "test-token";
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
      delete process.env.DISCLAW_TELEMETRY_TOKEN;
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
    process.env.DISCLAW_TELEMETRY_TOKEN = "test-token";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("boom"); }) as typeof fetch;
    try {
      track("command_run", {});
      await flush(); // must not throw
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.DISCLAW_TELEMETRY_TOKEN;
    }
  });
});

describe("withTelemetry", () => {
  it("tracks command_run + command_done with timing", async () => {
    delete process.env.DISCLAW_TELEMETRY;
    process.env.DISCLAW_TELEMETRY_TOKEN = "test-token";
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
      delete process.env.DISCLAW_TELEMETRY_TOKEN;
    }
  });

  it("returns exit code even when disabled", async () => {
    process.env.DISCLAW_TELEMETRY = "0";
    const wrapped = withTelemetry("validate", async () => 42);
    assert.equal(await wrapped({}), 42);
    delete process.env.DISCLAW_TELEMETRY;
  });
});
