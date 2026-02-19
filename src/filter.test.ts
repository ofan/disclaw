import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterActions, filterUnmanaged, filterAgents, filterSummary } from "./filter.ts";
import { parseTypeFilter } from "./types.ts";
import type { Action, UnmanagedResource } from "./types.ts";

const actions: Action[] = [
  { type: "create", resourceType: "category", name: "Homelab" },
  { type: "create", resourceType: "channel", name: "homelab" },
  { type: "update", resourceType: "channel", name: "notifications" },
  { type: "noop", resourceType: "thread", name: "K8s" },
  { type: "create", resourceType: "binding", name: "main → homelab" },
];

const unmanaged: UnmanagedResource[] = [
  { resourceType: "category", name: "Personal", id: "1" },
  { resourceType: "channel", name: "random", id: "2" },
  { resourceType: "thread", name: "Docker", id: "3" },
];

describe("parseTypeFilter", () => {
  it("returns null when no input", () => {
    assert.equal(parseTypeFilter(undefined), null);
    assert.equal(parseTypeFilter(""), null);
  });

  it("parses comma-separated types", () => {
    const f = parseTypeFilter("channel,thread")!;
    assert.equal(f.size, 2);
    assert.ok(f.has("channel"));
    assert.ok(f.has("thread"));
  });

  it("trims whitespace", () => {
    const f = parseTypeFilter(" channel , binding ")!;
    assert.equal(f.size, 2);
    assert.ok(f.has("channel"));
    assert.ok(f.has("binding"));
  });

  it("throws on unknown type", () => {
    assert.throws(() => parseTypeFilter("channel,bogus"), /Unknown resource type "bogus"/);
  });
});

describe("filterActions", () => {
  it("returns all actions when no filter", () => {
    const result = filterActions(actions, null);
    assert.equal(result.length, actions.length);
  });

  it("filters by resource type", () => {
    const result = filterActions(actions, new Set(["channel"]));
    assert.equal(result.length, 2);
    assert.ok(result.every((a) => a.resourceType === "channel"));
  });

  it("filters multiple types", () => {
    const result = filterActions(actions, new Set(["category", "thread"]));
    assert.equal(result.length, 2);
  });
});

describe("filterUnmanaged", () => {
  it("returns all when no filter", () => {
    const result = filterUnmanaged(unmanaged, null);
    assert.equal(result.length, 3);
  });

  it("filters by resource type", () => {
    const result = filterUnmanaged(unmanaged, new Set(["category"]));
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Personal");
  });
});

describe("filterAgents", () => {
  it("returns all when no filter", () => {
    const result = filterAgents(["coder", "main"], null);
    assert.equal(result.length, 2);
  });

  it("returns agents when binding type included", () => {
    const result = filterAgents(["coder", "main"], new Set(["binding"]));
    assert.equal(result.length, 2);
  });

  it("returns empty when binding type not included", () => {
    const result = filterAgents(["coder", "main"], new Set(["channel"]));
    assert.equal(result.length, 0);
  });
});

describe("filterSummary", () => {
  it("returns summary with counts", () => {
    const summary = filterSummary(2, 10, new Set(["channel"]));
    assert.ok(summary.includes("2"));
    assert.ok(summary.includes("10"));
  });

  it("returns empty string when no filter active", () => {
    const summary = filterSummary(10, 10, null);
    assert.equal(summary, "");
  });
});
