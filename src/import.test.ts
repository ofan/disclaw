import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDocument } from "yaml";
import { parseConfig, flattenDesiredState } from "./parser.ts";
import type { DesiredState } from "./types.ts";

function toDesiredState(config: ReturnType<typeof parseConfig>): DesiredState {
  const server = config.servers.default;
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
