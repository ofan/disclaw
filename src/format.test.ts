import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toDiffJson } from "./format.ts";
import type { Action, UnmanagedResource, ActualPin, ActualChannel } from "./types.ts";

describe("toDiffJson", () => {
  it("converts actions to flat JSON entries", () => {
    const actions: Action[] = [
      { type: "create", resourceType: "category", name: "Homelab", details: { after: { name: "Homelab" } } },
      { type: "update", resourceType: "channel", name: "notifications",
        details: { before: { topic: "old" }, after: { topic: "new" } } },
      { type: "noop", resourceType: "channel", name: "general" },
    ];

    const result = toDiffJson({ actions, unmanaged: [], unboundAgents: [], staleAgents: [], pins: [], channels: [] });
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], { op: "create", type: "category", name: "Homelab", after: { name: "Homelab" } });
    assert.equal(result[1].op, "update");
    assert.deepEqual(result[1].before, { topic: "old" });
    assert.deepEqual(result[1].after, { topic: "new" });
    assert.equal(result[2].op, "noop");
  });

  it("includes unmanaged resources", () => {
    const unmanaged: UnmanagedResource[] = [
      { resourceType: "category", name: "Personal", id: "1" },
    ];
    const result = toDiffJson({ actions: [], unmanaged, unboundAgents: [], staleAgents: [], pins: [], channels: [] });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { op: "unmanaged", type: "category", name: "Personal" });
  });

  it("includes unbound and stale agents", () => {
    const result = toDiffJson({
      actions: [], unmanaged: [],
      unboundAgents: ["coder"], staleAgents: ["retired"],
      pins: [], channels: [],
    });
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], { op: "unbound", type: "agent", name: "coder" });
    assert.deepEqual(result[1], { op: "stale", type: "agent", name: "retired" });
  });

  it("includes pin summaries", () => {
    const pins: ActualPin[] = [
      { messageId: "m1", channelId: "ch1", content: "hello" },
      { messageId: "m2", channelId: "ch1", content: "world" },
    ];
    const channels: ActualChannel[] = [
      { id: "ch1", name: "general", type: "text" },
    ];
    const result = toDiffJson({ actions: [], unmanaged: [], unboundAgents: [], staleAgents: [], pins, channels });
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { op: "pin", type: "pin", name: "general", count: 2 });
  });
});
