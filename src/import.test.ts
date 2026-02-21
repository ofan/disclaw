import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDocument } from "yaml";
import { parseConfig, flattenDesiredState } from "./parser.ts";
import type { DesiredState } from "./types.ts";

function toDesiredState(config: ReturnType<typeof parseConfig>, serverName = "default"): DesiredState {
  const server = config.servers[serverName];
  return { version: 1, managedBy: "disclaw", guild: server.guild, channels: server.channels, openclaw: server.openclaw };
}

describe("import YAML manipulation", () => {
  const baseYaml = `version: 1
managedBy: disclaw
guild: "123"

channels:
  - name: homelab
    topic: "Ops"
    threads: [K8s]

  - category: Work
    channels:
      - name: dev
        topic: "Development"
`;

  it("appends a channel to existing YAML preserving structure", () => {
    const doc = parseDocument(baseYaml);
    const channels = doc.getIn(["channels"]) as any;
    channels.add(doc.createNode({ name: "new-channel", topic: "Imported" }));

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed));
    assert.equal(flat.channels.length, 3);
    assert.ok(flat.channels.some((c) => c.name === "new-channel" && c.topic === "Imported"));
  });

  it("appends a thread to an inline threads array", () => {
    const doc = parseDocument(baseYaml);
    // Find the homelab channel and add a thread
    const channels = doc.getIn(["channels"]) as any;
    const homelabItem = channels.items[0].value ?? channels.items[0];
    let threadsNode = homelabItem.get("threads");
    threadsNode.add("Docker");

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed));
    assert.ok(flat.threads.some((t) => t.parentChannel === "homelab" && t.name === "Docker"));
  });

  it("appends channel without topic when topic is undefined", () => {
    const doc = parseDocument(baseYaml);
    const channels = doc.getIn(["channels"]) as any;
    channels.add(doc.createNode({ name: "no-topic" }));

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed));
    assert.ok(flat.channels.some((c) => c.name === "no-topic" && c.topic === undefined));
  });

  it("round-trips through file write/read", () => {
    const dir = mkdtempSync(join(tmpdir(), "disclaw-import-"));
    const configPath = join(dir, "disclaw.yaml");
    writeFileSync(configPath, baseYaml, "utf-8");

    const raw = readFileSync(configPath, "utf-8");
    const doc = parseDocument(raw);
    const channels = doc.getIn(["channels"]) as any;
    channels.add(doc.createNode({ name: "imported", topic: "Test" }));
    writeFileSync(configPath, doc.toString(), "utf-8");

    const updated = readFileSync(configPath, "utf-8");
    const parsed = parseConfig(updated);
    const flat = flattenDesiredState(toDesiredState(parsed));
    assert.equal(flat.channels.length, 3);
    assert.ok(flat.channels.some((c) => c.name === "imported"));
  });
});

describe("import YAML manipulation — multi-server", () => {
  const multiYaml = `version: 1
managedBy: disclaw

servers:
  prod:
    guild: "111"
    channels:
      - name: general
        topic: "Main"

  staging:
    guild: "222"
    channels:
      - name: testing
        topic: "QA"
      - category: Infra
        channels:
          - name: deploy
            topic: "Deployments"
`;

  it("appends a channel to a specific server in multi-server config", () => {
    const doc = parseDocument(multiYaml);
    const channels = doc.getIn(["servers", "prod", "channels"]) as any;
    channels.add(doc.createNode({ name: "new-channel", topic: "Imported" }));

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed, "prod"));
    assert.equal(flat.channels.length, 2);
    assert.ok(flat.channels.some((c) => c.name === "new-channel" && c.topic === "Imported"));

    // Other server unchanged
    const stagingFlat = flattenDesiredState(toDesiredState(parsed, "staging"));
    assert.equal(stagingFlat.channels.length, 2);
  });

  it("appends a category group to a specific server", () => {
    const doc = parseDocument(multiYaml);
    const channels = doc.getIn(["servers", "prod", "channels"]) as any;
    const group = { category: "NewCat", channels: [{ name: "cat-channel", topic: "From import" }] };
    channels.add(doc.createNode(group));

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed, "prod"));
    assert.ok(flat.categories.includes("NewCat"));
    assert.ok(flat.channels.some((c) => c.name === "cat-channel" && c.categoryName === "NewCat"));
  });

  it("adds agents to a specific server's openclaw section", () => {
    const doc = parseDocument(multiYaml);
    const agentsPath = ["servers", "prod", "openclaw", "agents"];

    doc.setIn(agentsPath, doc.createNode({}));
    const agentsNode = doc.getIn(agentsPath) as any;
    // Use an existing channel name so validation passes
    agentsNode.set("my-agent", "general");

    const output = doc.toString();
    const parsed = parseConfig(output);
    const prodServer = parsed.servers.prod;
    assert.ok(prodServer.openclaw);
    assert.equal(prodServer.openclaw!.agents["my-agent"], "general");
  });

  it("appends thread to parent channel inside multi-server config", () => {
    const doc = parseDocument(multiYaml);
    const channels = doc.getIn(["servers", "staging", "channels"]) as any;

    // Find the testing channel (first item) and add a thread
    const testingItem = channels.items[0].value ?? channels.items[0];
    assert.equal(testingItem.get("name"), "testing");
    testingItem.set("threads", doc.createNode(["new-thread"]));

    const output = doc.toString();
    const parsed = parseConfig(output);
    const flat = flattenDesiredState(toDesiredState(parsed, "staging"));
    assert.ok(flat.threads.some((t) => t.parentChannel === "testing" && t.name === "new-thread"));
  });

  it("round-trips multi-server config through file write/read", () => {
    const dir = mkdtempSync(join(tmpdir(), "disclaw-import-multi-"));
    const configPath = join(dir, "disclaw.yaml");
    writeFileSync(configPath, multiYaml, "utf-8");

    const raw = readFileSync(configPath, "utf-8");
    const doc = parseDocument(raw);

    // Add channel to prod
    const prodChannels = doc.getIn(["servers", "prod", "channels"]) as any;
    prodChannels.add(doc.createNode({ name: "imported-prod" }));

    // Add channel to staging
    const stagingChannels = doc.getIn(["servers", "staging", "channels"]) as any;
    stagingChannels.add(doc.createNode({ name: "imported-staging" }));

    writeFileSync(configPath, doc.toString(), "utf-8");

    const updated = readFileSync(configPath, "utf-8");
    const parsed = parseConfig(updated);
    const prodFlat = flattenDesiredState(toDesiredState(parsed, "prod"));
    const stagingFlat = flattenDesiredState(toDesiredState(parsed, "staging"));

    assert.equal(prodFlat.channels.length, 2);
    assert.ok(prodFlat.channels.some((c) => c.name === "imported-prod"));
    assert.equal(stagingFlat.channels.length, 3);
    assert.ok(stagingFlat.channels.some((c) => c.name === "imported-staging"));
  });
});
