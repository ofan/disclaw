import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { saveSnapshot, loadLatestSnapshot, listSnapshots } from "./snapshot.ts";
import { rmSync, mkdirSync } from "node:fs";
import type { Snapshot } from "./types.ts";

const TEST_DIR = ".disclaw-test-snapshots";

const mockSnapshot: Snapshot = {
  timestamp: new Date().toISOString(),
  configHash: "abc123",
  discord: { categories: [], channels: [], threads: [], pins: [] },
  openclaw: { bindings: [] },
};

describe("snapshot", () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("saves and loads a snapshot", async () => {
    const path = await saveSnapshot(mockSnapshot, TEST_DIR);
    assert.ok(path.endsWith(".json"));
    const loaded = await loadLatestSnapshot(TEST_DIR);
    assert.ok(loaded);
    assert.equal(loaded.configHash, "abc123");
  });

  it("returns null when no snapshots exist", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const loaded = await loadLatestSnapshot(TEST_DIR);
    assert.equal(loaded, null);
  });

  it("lists snapshots in reverse chronological order", async () => {
    await saveSnapshot({ ...mockSnapshot, configHash: "first" }, TEST_DIR);
    await new Promise((r) => setTimeout(r, 50));
    await saveSnapshot({ ...mockSnapshot, configHash: "second" }, TEST_DIR);
    const list = await listSnapshots(TEST_DIR);
    assert.equal(list.length, 2);
    const latest = await loadLatestSnapshot(TEST_DIR);
    assert.equal(latest?.configHash, "second");
  });
});
