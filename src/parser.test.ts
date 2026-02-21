import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, flattenDesiredState } from "./parser.ts";
import { readFileSync } from "node:fs";
import type { DesiredState } from "./types.ts";
import { isCategoryGroup } from "./types.ts";

describe("parseConfig", () => {
  it("parses valid disclaw.yaml", () => {
    const raw = readFileSync("disclaw.example.yaml", "utf-8");
    const result = parseConfig(raw);
    assert.equal(result.singleServer, true);
    assert.ok(result.servers.default);
    assert.equal(result.servers.default.guild, "YOUR_GUILD_ID");
    assert.ok(result.servers.default.channels.length >= 3);
    assert.ok(result.servers.default.openclaw);
    assert.ok(result.servers.default.openclaw.agents.alerts);
  });

  it("parses mixed array: standalone channels + category groups", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: random
    topic: Fun stuff
  - category: Work
    channels:
      - name: dev
      - name: ops
        topic: Operations
`;
    const result = parseConfig(yaml);
    assert.equal(result.servers.default.channels.length, 3);

    // First two are standalone
    assert.ok(!isCategoryGroup(result.servers.default.channels[0]));
    assert.ok(!isCategoryGroup(result.servers.default.channels[1]));

    // Third is a category group
    assert.ok(isCategoryGroup(result.servers.default.channels[2]));
    const group = result.servers.default.channels[2] as { category: string; channels: { name: string }[] };
    assert.equal(group.category, "Work");
    assert.equal(group.channels.length, 2);
  });

  it("rejects duplicate channel names", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - category: Work
    channels:
      - name: general
`;
    assert.throws(() => parseConfig(yaml), {
      message: 'Duplicate channel name: "general"',
    });
  });

  it("rejects duplicate category names", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - category: Work
    channels:
      - name: dev
  - category: Work
    channels:
      - name: ops
`;
    assert.throws(() => parseConfig(yaml), {
      message: 'Duplicate category name: "Work"',
    });
  });

  it("rejects invalid config (missing version)", () => {
    assert.throws(() => parseConfig("managedBy: disclaw\n"), {
      message: /must have.*guild.*or.*servers/i,
    });
  });

  it("rejects wrong managedBy value", () => {
    assert.throws(
      () => parseConfig("version: 1\nmanagedBy: terraform\nguild: '123'\nchannels: []\n"),
    );
  });

  it("rejects empty channel name", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: ""
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Empty name/,
    });
  });

  it("rejects empty category name", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - category: ""
    channels:
      - name: dev
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Empty name/,
    });
  });

  it("rejects empty thread name", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: dev
    threads: [""]
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Empty name/,
    });
  });

  it("rejects duplicate thread names under same parent", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: dev
    threads: [Frontend, Frontend]
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Duplicate thread "Frontend" under channel "dev"/,
    });
  });

  it("allows same thread name under different parents", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: dev
    threads: [Help]
  - name: ops
    threads: [Help]
`;
    // Should NOT throw — same thread name in different channels is fine
    const result = parseConfig(yaml);
    assert.equal(result.servers.default.channels.length, 2);
  });

  it("rejects agent binding to channel not in config", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main: lobby
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Agent "main" binds to "lobby" but no channel "lobby" is defined/,
    });
  });

  it("rejects binding in object form to missing channel", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main:
      channel: [general, missing]
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Agent "main" binds to "missing" but no channel "missing" is defined/,
    });
  });

  it("rejects binding in mixed array to missing channel", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main:
      - general
      - channel: nonexistent
        requireMention: true
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Agent "main" binds to "nonexistent" but no channel "nonexistent" is defined/,
    });
  });

  it("rejects duplicate binding (same channel twice in array)", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main: [general, general]
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Duplicate binding: agent "main" → channel "general"/,
    });
  });

  it("rejects duplicate binding in mixed array", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main:
      - general
      - channel: general
        requireMention: true
`;
    assert.throws(() => parseConfig(yaml), {
      message: /Duplicate binding: agent "main" → channel "general"/,
    });
  });

  it("warns on empty category (does not throw)", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - category: Sandbox
    channels: []
  - name: general
`;
    const result = parseConfig(yaml);
    assert.ok(result.warnings);
    assert.ok(result.warnings.some((w) => w.includes("Sandbox")));
  });

  it("no warnings for valid config", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - category: Work
    channels:
      - name: dev
  - name: general
`;
    const result = parseConfig(yaml);
    assert.equal(result.warnings, undefined);
  });

  it("parses private and addBot on channels", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: alerts
    private: true
    addBot: true
  - name: general
`;
    const result = parseConfig(yaml);
    const alertsEntry = result.servers.default.channels[0] as { name: string; private?: boolean; addBot?: boolean };
    assert.equal(alertsEntry.private, true);
    assert.equal(alertsEntry.addBot, true);

    const generalEntry = result.servers.default.channels[1] as { name: string; private?: boolean; addBot?: boolean };
    assert.equal(generalEntry.private, undefined);
    assert.equal(generalEntry.addBot, undefined);
  });

  it("warns on addBot without private", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
    addBot: true
`;
    const result = parseConfig(yaml);
    assert.ok(result.warnings);
    assert.ok(result.warnings.some((w) => w.includes("addBot") && w.includes("general")));
  });
});

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

describe("flattenDesiredState", () => {
  it("extracts flat lists from nested structure", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
    threads: [Ideas, Planning]
  - category: Work
    channels:
      - name: dev
        topic: Development
        threads: [Frontend]
      - name: ops
openclaw:
  agents:
    main: dev
    siren: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.deepEqual(flat.categories, ["Work"]);
    assert.equal(flat.channels.length, 3);
    assert.ok(flat.channels.some((c) => c.name === "general" && c.categoryName === undefined));
    assert.ok(flat.channels.some((c) => c.name === "dev" && c.categoryName === "Work"));
    assert.ok(flat.channels.some((c) => c.name === "ops" && c.categoryName === "Work"));

    assert.equal(flat.threads.length, 3);
    assert.ok(flat.threads.some((t) => t.parentChannel === "general" && t.name === "Ideas"));
    assert.ok(flat.threads.some((t) => t.parentChannel === "dev" && t.name === "Frontend"));

    assert.equal(flat.bindings.length, 2);
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "dev"));
    assert.ok(flat.bindings.some((b) => b.agentName === "siren" && b.channelRef === "general"));
  });

  it("expands one-to-many agent bindings", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: dev
  - name: ops
openclaw:
  agents:
    main: [general, dev, ops]
    siren: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 4);
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "general"));
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "dev"));
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "ops"));
    assert.ok(flat.bindings.some((b) => b.agentName === "siren" && b.channelRef === "general"));
  });

  it("handles no categories and no openclaw", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.deepEqual(flat.categories, []);
    assert.equal(flat.channels.length, 1);
    assert.equal(flat.threads.length, 0);
    assert.equal(flat.bindings.length, 0);
  });

  it("parses agent binding object form with requireMention", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: homelab
openclaw:
  requireMention: true
  agents:
    main:
      channel: homelab
      requireMention: false
    siren: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 2);
    const mainBinding = flat.bindings.find((b) => b.agentName === "main");
    const sirenBinding = flat.bindings.find((b) => b.agentName === "siren");
    assert.ok(mainBinding);
    assert.equal(mainBinding.channelRef, "homelab");
    assert.equal(mainBinding.requireMention, false);
    assert.ok(sirenBinding);
    assert.equal(sirenBinding.channelRef, "general");
    assert.equal(sirenBinding.requireMention, true); // inherits guild default
  });

  it("parses agent binding object form with multiple channels", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: homelab
  - name: alerts
openclaw:
  agents:
    main:
      channel: [homelab, general]
      requireMention: false
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 2);
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "homelab" && b.requireMention === false));
    assert.ok(flat.bindings.some((b) => b.agentName === "main" && b.channelRef === "general" && b.requireMention === false));
  });

  it("inherits guild-level requireMention for string shorthand", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  requireMention: false
  agents:
    main: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 1);
    assert.equal(flat.bindings[0].requireMention, false);
  });

  it("parses mixed array with per-channel requireMention", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: backend
  - name: frontend
openclaw:
  agents:
    main:
      - general
      - channel: backend
        requireMention: true
      - channel: frontend
        requireMention: false
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 3);
    const general = flat.bindings.find((b) => b.channelRef === "general");
    const backend = flat.bindings.find((b) => b.channelRef === "backend");
    const frontend = flat.bindings.find((b) => b.channelRef === "frontend");
    assert.ok(general);
    assert.equal(general.requireMention, undefined); // no guild default
    assert.ok(backend);
    assert.equal(backend.requireMention, true);
    assert.ok(frontend);
    assert.equal(frontend.requireMention, false);
  });

  it("mixed array inherits guild default for bare strings", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
  - name: backend
openclaw:
  requireMention: true
  agents:
    main:
      - general
      - channel: backend
        requireMention: false
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 2);
    const general = flat.bindings.find((b) => b.channelRef === "general");
    const backend = flat.bindings.find((b) => b.channelRef === "backend");
    assert.equal(general!.requireMention, true);  // inherits guild default
    assert.equal(backend!.requireMention, false);  // per-channel override
  });

  it("leaves requireMention undefined when no guild default", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: general
openclaw:
  agents:
    main: general
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    assert.equal(flat.bindings.length, 1);
    assert.equal(flat.bindings[0].requireMention, undefined);
  });

  it("forwards private and addBot to flat channels", () => {
    const yaml = `
version: 1
managedBy: disclaw
guild: "123"
channels:
  - name: alerts
    private: true
    addBot: true
  - category: Work
    channels:
      - name: dev
        private: true
`;
    const config = parseConfig(yaml);
    const server = config.servers.default;
    const state: DesiredState = { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
    const flat = flattenDesiredState(state);

    const alerts = flat.channels.find((c) => c.name === "alerts");
    assert.ok(alerts);
    assert.equal(alerts.private, true);
    assert.equal(alerts.addBot, true);

    const dev = flat.channels.find((c) => c.name === "dev");
    assert.ok(dev);
    assert.equal(dev.private, true);
    assert.equal(dev.addBot, undefined);
  });
});
