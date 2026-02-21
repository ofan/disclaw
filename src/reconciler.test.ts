import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./reconciler.ts";
import type { DesiredState, DiscordState, OpenClawState } from "./types.ts";

const desired: DesiredState = {
  version: 1,
  managedBy: "disclaw",
  guild: "123",
  channels: [
    {
      category: "Homelab",
      channels: [
        { name: "homelab", topic: "Ops", threads: ["K8s"] },
        { name: "homelab-alerts", topic: "Alerts" },
      ],
    },
  ],
  openclaw: {
    agents: { main: "homelab" },
  },
};

describe("reconcile", () => {
  it("returns all creates when actual is empty", () => {
    const emptyDiscord: DiscordState = {
      categories: [],
      channels: [],
      threads: [],
      pins: [],
    };
    const emptyOC: OpenClawState = { bindings: [] };

    const { actions } = reconcile(desired, emptyDiscord, emptyOC);
    const creates = actions.filter((a) => a.type === "create");
    assert.ok(creates.length >= 4); // category + 2 channels + 1 thread + 1 binding
    assert.ok(creates.some((a) => a.resourceType === "category" && a.name === "Homelab"));
    assert.ok(creates.some((a) => a.resourceType === "channel" && a.name === "homelab"));
    assert.ok(creates.some((a) => a.resourceType === "thread" && a.name === "K8s"));
    assert.ok(creates.some((a) => a.resourceType === "binding"));
  });

  it("returns noop when actual matches desired", () => {
    const matchingDiscord: DiscordState = {
      categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1", managedBy: "disclaw" },
      ],
      threads: [
        { id: "th1", name: "K8s", parentChannelId: "ch1", managedBy: "disclaw" },
      ],
      pins: [],
    };
    const matchingOC: OpenClawState = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "discord", peer: { kind: "channel", id: "ch1" } },
        },
      ],
    };

    const { actions } = reconcile(desired, matchingDiscord, matchingOC);
    const noops = actions.filter((a) => a.type === "noop");
    assert.ok(noops.length > 0);
    const creates = actions.filter((a) => a.type === "create");
    assert.equal(creates.length, 0);
  });

  it("detects topic update on existing channel", () => {
    const driftedDiscord: DiscordState = {
      categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Old topic", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1", managedBy: "disclaw" },
      ],
      threads: [
        { id: "th1", name: "K8s", parentChannelId: "ch1", managedBy: "disclaw" },
      ],
      pins: [],
    };
    const matchingOC: OpenClawState = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "discord", peer: { kind: "channel", id: "ch1" } },
        },
      ],
    };

    const { actions } = reconcile(desired, driftedDiscord, matchingOC);
    const updates = actions.filter((a) => a.type === "update");
    assert.ok(updates.some((a) => a.name === "homelab"));
  });

  it("detects unmanaged channels and threads", () => {
    const discordWithExtra: DiscordState = {
      categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch3", name: "random-stuff", type: "text", topic: "Random" },
      ],
      threads: [
        { id: "th1", name: "K8s", parentChannelId: "ch1", managedBy: "disclaw" },
        { id: "th2", name: "Docker", parentChannelId: "ch1" },
      ],
      pins: [],
    };
    const matchingOC: OpenClawState = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "discord", peer: { kind: "channel", id: "ch1" } },
        },
      ],
    };

    const { actions, unmanaged } = reconcile(desired, discordWithExtra, matchingOC);
    assert.ok(actions.length > 0);
    assert.equal(unmanaged.length, 2);
    assert.ok(unmanaged.some((u) => u.resourceType === "channel" && u.name === "random-stuff"));
    assert.ok(unmanaged.some((u) => u.resourceType === "thread" && u.name === "Docker"));
  });

  it("returns deterministic ordering", () => {
    const empty: DiscordState = { categories: [], channels: [], threads: [], pins: [] };
    const emptyOC: OpenClawState = { bindings: [] };

    const { actions: a1 } = reconcile(desired, empty, emptyOC);
    const { actions: a2 } = reconcile(desired, empty, emptyOC);
    assert.deepEqual(
      a1.map((a) => `${a.type}:${a.resourceType}:${a.name}`),
      a2.map((a) => `${a.type}:${a.resourceType}:${a.name}`),
    );
  });

  it("handles multiple categories", () => {
    const multiCat: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [
        {
          category: "Alpha",
          channels: [{ name: "alpha-general" }],
        },
        {
          category: "Beta",
          channels: [{ name: "beta-general" }],
        },
      ],
    };
    const empty: DiscordState = { categories: [], channels: [], threads: [], pins: [] };
    const emptyOC: OpenClawState = { bindings: [] };

    const { actions } = reconcile(multiCat, empty, emptyOC);
    const catCreates = actions.filter((a) => a.resourceType === "category" && a.type === "create");
    assert.equal(catCreates.length, 2);
    assert.ok(catCreates.some((a) => a.name === "Alpha"));
    assert.ok(catCreates.some((a) => a.name === "Beta"));
  });

  it("emits delete actions with prune=true", () => {
    const discordWithExtra: DiscordState = {
      categories: [
        { id: "cat1", name: "Homelab", managedBy: "disclaw" },
        { id: "cat2", name: "Sandbox", managedBy: "disclaw" },
      ],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch3", name: "old-channel", type: "text" },
      ],
      threads: [
        { id: "th1", name: "K8s", parentChannelId: "ch1", managedBy: "disclaw" },
        { id: "th2", name: "Stale Thread", parentChannelId: "ch1" },
      ],
      pins: [],
    };
    const matchingOC: OpenClawState = {
      bindings: [
        { agentId: "main", match: { channel: "discord", peer: { kind: "channel", id: "ch1" } } },
      ],
    };

    const { actions, unmanaged } = reconcile(desired, discordWithExtra, matchingOC, { prune: true });

    // With prune, unmanaged should be empty — they become delete actions
    assert.equal(unmanaged.length, 0);

    const deletes = actions.filter((a) => a.type === "delete");
    assert.ok(deletes.some((a) => a.resourceType === "category" && a.name === "Sandbox"));
    assert.ok(deletes.some((a) => a.resourceType === "channel" && a.name === "old-channel"));
    assert.ok(deletes.some((a) => a.resourceType === "thread" && a.name === "Stale Thread"));

    // Delete actions should carry the resource ID in details.before
    const chDelete = deletes.find((a) => a.name === "old-channel");
    assert.equal((chDelete!.details!.before as Record<string, string>).id, "ch3");
  });

  it("emits binding delete for stale bindings", () => {
    const discordState: DiscordState = {
      categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1", managedBy: "disclaw" },
        { id: "ch3", name: "old-channel", type: "text" },
      ],
      threads: [{ id: "th1", name: "K8s", parentChannelId: "ch1", managedBy: "disclaw" }],
      pins: [],
    };
    const ocWithStale: OpenClawState = {
      bindings: [
        { agentId: "main", match: { channel: "discord", peer: { kind: "channel", id: "ch1" } } },
        { agentId: "stale-agent", match: { channel: "discord", peer: { kind: "channel", id: "ch3" } } },
      ],
    };

    const { actions } = reconcile(desired, discordState, ocWithStale);
    const bindingDeletes = actions.filter((a) => a.resourceType === "binding" && a.type === "delete");
    assert.equal(bindingDeletes.length, 1);
    assert.ok(bindingDeletes[0].name.includes("stale-agent"));
    assert.equal(
      (bindingDeletes[0].details!.before as Record<string, string>).resolvedChannelId,
      "ch3",
    );
  });

  it("without prune, unmanaged resources stay in unmanaged array", () => {
    const discordWithExtra: DiscordState = {
      categories: [{ id: "cat1", name: "Homelab", managedBy: "disclaw" }],
      channels: [
        { id: "ch1", name: "homelab", type: "text", topic: "Ops", categoryId: "cat1" },
        { id: "ch2", name: "homelab-alerts", type: "text", topic: "Alerts", categoryId: "cat1" },
        { id: "ch3", name: "extra", type: "text" },
      ],
      threads: [{ id: "th1", name: "K8s", parentChannelId: "ch1" }],
      pins: [],
    };
    const emptyOC: OpenClawState = { bindings: [] };

    const { actions, unmanaged } = reconcile(desired, discordWithExtra, emptyOC, { prune: false });
    assert.ok(unmanaged.some((u) => u.name === "extra"));
    assert.ok(!actions.some((a) => a.type === "delete" && a.resourceType === "channel"));
  });

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

  it("handles top-level channels (no category)", () => {
    const topLevel: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [
        { name: "general" },
        { name: "random", topic: "Fun" },
      ],
    };
    const empty: DiscordState = { categories: [], channels: [], threads: [], pins: [] };
    const emptyOC: OpenClawState = { bindings: [] };

    const { actions } = reconcile(topLevel, empty, emptyOC);
    const catActions = actions.filter((a) => a.resourceType === "category");
    assert.equal(catActions.length, 0); // No categories
    const channelCreates = actions.filter((a) => a.resourceType === "channel" && a.type === "create");
    assert.equal(channelCreates.length, 2);
  });
});

const emptyOC: OpenClawState = { bindings: [] };

describe("reconcile private/addBot", () => {
  it("creates channel with private and addBot in details", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = { categories: [], channels: [], threads: [], pins: [] };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "create");
    assert.equal((action.details?.after as any)?.private, true);
    assert.equal((action.details?.after as any)?.addBot, true);
  });

  it("detects private change from false to true", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text" }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "update");
    assert.equal((action.details?.after as any)?.private, true);
  });

  it("detects addBot change", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text", private: true }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "update");
    assert.equal((action.details?.after as any)?.addBot, true);
  });

  it("noop when private and addBot match", () => {
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: "123",
      channels: [{ name: "alerts", private: true, addBot: true }],
    };
    const discord: DiscordState = {
      categories: [],
      channels: [{ id: "1", name: "alerts", type: "text", private: true, addBot: true }],
      threads: [],
      pins: [],
    };

    const result = reconcile(desired, discord, emptyOC);
    const action = result.actions.find((a) => a.name === "alerts");
    assert.ok(action);
    assert.equal(action.type, "noop");
  });
});
