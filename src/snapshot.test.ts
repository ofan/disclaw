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

  it("handles multi-server snapshot with multiple servers", () => {
    const multi: MultiServerSnapshot = {
      timestamp: new Date().toISOString(),
      configHash: "multi",
      servers: {
        production: {
          guildId: "111",
          discord: { categories: [], channels: [], threads: [], pins: [] },
        },
        staging: {
          guildId: "222",
          discord: { categories: [], channels: [], threads: [], pins: [] },
        },
      },
      openclaw: { bindings: [] },
    };
    saveSnapshot(multi, TEST_FILE);
    const loaded = loadSnapshot(TEST_FILE);
    assert.ok(loaded);
    assert.equal(Object.keys(loaded.servers).length, 2);
    assert.equal(loaded.servers.production.guildId, "111");
    assert.equal(loaded.servers.staging.guildId, "222");
  });
});
