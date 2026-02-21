// src/commands/import.ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseConfig, flattenDesiredState } from "../parser.ts";
import { formatUnmanaged, formatUnboundAgents, toDiffJson } from "../format.ts";
import { filterUnmanaged, filterAgents, filterSummary } from "../filter.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type { UnmanagedResource, ResourceTypeFilter, GatewayOptions } from "../types.ts";

export async function importCommand(
  configPath: string,
  yes: boolean,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  gwOpts?: GatewayOptions,
): Promise<number> {
  const raw = readFileSync(configPath, "utf-8");
  const desired = parseConfig(raw);
  if (desired.warnings?.length) {
    for (const w of desired.warnings) console.log(`\u26A0 ${w}`);
  }

  const token = await resolveDiscordToken(gwOpts);
  const discord = new DiscordProvider(token, desired.guild);
  await discord.login();

  try {
    // Guild-wide fetch — finds ALL channels
    const guildState = await discord.fetch();

    const flat = flattenDesiredState(desired);
    const desiredCategoryNames = new Set(flat.categories);
    const desiredChannelNames = new Set(flat.channels.map((c) => c.name));
    const desiredThreadKeys = new Set(
      flat.threads.map((t) => `${t.parentChannel}:${t.name}`),
    );

    const unmanaged: UnmanagedResource[] = [];

    // Detect unmanaged categories
    for (const cat of guildState.categories) {
      if (!desiredCategoryNames.has(cat.name)) {
        unmanaged.push({
          resourceType: "category",
          name: cat.name,
          id: cat.id,
        });
      }
    }

    for (const ch of guildState.channels) {
      if (!desiredChannelNames.has(ch.name)) {
        unmanaged.push({
          resourceType: "channel",
          name: ch.name,
          id: ch.id,
          topic: ch.topic,
        });
      }
    }

    for (const th of guildState.threads) {
      const parentChannel = guildState.channels.find((c) => c.id === th.parentChannelId);
      const key = parentChannel ? `${parentChannel.name}:${th.name}` : `:${th.name}`;
      if (!desiredThreadKeys.has(key)) {
        unmanaged.push({
          resourceType: "thread",
          name: th.name,
          id: th.id,
        });
      }
    }

    // Check for unbound OpenClaw agents
    let unboundAgents: string[] = [];
    const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
    if (resolved) {
      try {
        const agents = await resolved.provider.fetchAgents();
        const configAgentNames = new Set(flat.bindings.map((b) => b.agentName));
        unboundAgents = agents.filter((a) => !configAgentNames.has(a));
      } catch {
        // agents list may not be available
      }
    }

    // Apply filters
    const filteredUnmanaged = filterUnmanaged(unmanaged, filter);
    const filteredAgents = filterAgents(unboundAgents, filter);

    if (filteredUnmanaged.length === 0 && filteredAgents.length === 0) {
      if (json) {
        console.log("[]");
      } else {
        console.log("No unmanaged resources found. Nothing to import.");
      }
      return 0;
    }

    if (json && !yes) {
      const entries = toDiffJson({
        actions: [], unmanaged: filteredUnmanaged,
        unboundAgents: filteredAgents, staleAgents: [],
        pins: [], channels: [],
      });
      console.log(JSON.stringify(entries, null, 2));
      return 0;
    }

    if (!json) {
      if (filteredUnmanaged.length > 0) {
        console.log(formatUnmanaged(filteredUnmanaged));
      }
      if (filteredAgents.length > 0) {
        console.log(formatUnboundAgents(filteredAgents));
      }

      const totalCount = unmanaged.length + unboundAgents.length;
      const showingCount = filteredUnmanaged.length + filteredAgents.length;
      const summary = filterSummary(showingCount, totalCount, filter);
      if (summary) console.log(summary);
    }

    if (!yes) {
      if (!json) console.log("Dry-run mode. Use --yes to import these resources into your config.");
      return 0;
    }

    // Use YAML document model to preserve formatting where possible
    const doc = parseDocument(raw);
    const channels = doc.getIn(["channels"]) as any;

    let importedCount = 0;

    // Track which channels belong to filtered categories so we nest them
    const channelsInUnmanagedCategories = new Set<string>();

    // Import categories first, nesting their channels inside
    for (const r of filteredUnmanaged) {
      if (r.resourceType !== "category") continue;

      const childChannels = guildState.channels.filter(
        (ch) => ch.categoryId === r.id && !desiredChannelNames.has(ch.name),
      );

      const childEntries = childChannels.map((ch) => {
        channelsInUnmanagedCategories.add(ch.id);
        const entry: Record<string, unknown> = { name: ch.name };
        if (ch.topic) entry.topic = ch.topic;
        if (ch.restricted) entry.restricted = true;
        if (ch.private) entry.private = true;
        if (ch.addBot) entry.addBot = true;
        return entry;
      });

      const group: Record<string, unknown> = { category: r.name, channels: childEntries };
      channels.add(doc.createNode(group));
      importedCount += 1 + childEntries.length;
    }

    // Import standalone channels (skip ones already nested in a category)
    for (const r of filteredUnmanaged) {
      if (r.resourceType === "channel" && !channelsInUnmanagedCategories.has(r.id)) {
        const entry: Record<string, unknown> = { name: r.name };
        if (r.topic) entry.topic = r.topic;
        // Check if the source channel is restricted
        const srcCh = guildState.channels.find((ch) => ch.id === r.id);
        if (srcCh?.restricted) entry.restricted = true;
        if (srcCh?.private) entry.private = true;
        if (srcCh?.addBot) entry.addBot = true;
        channels.add(doc.createNode(entry));
        importedCount++;
      } else if (r.resourceType === "thread") {
        const parentChannel = guildState.channels.find(
          (ch) => guildState.threads.find(
            (th) => th.name === r.name && th.id === r.id,
          )?.parentChannelId === ch.id,
        );
        if (parentChannel) {
          // Find the parent channel entry and add thread to its threads array
          addThreadToChannel(doc, channels, parentChannel.name, r.name);
          importedCount++;
        }
      }
    }

    // Import unbound agents into openclaw.agents
    if (filteredAgents.length > 0) {
      let agentsNode = doc.getIn(["openclaw", "agents"]) as any;
      if (!agentsNode) {
        doc.setIn(["openclaw", "agents"], doc.createNode({}));
        agentsNode = doc.getIn(["openclaw", "agents"]) as any;
      }
      for (const agent of filteredAgents) {
        // Default to empty string — user must fill in channelRef
        agentsNode.set(agent, "TODO");
        importedCount++;
      }
    }

    writeFileSync(configPath, doc.toString(), "utf-8");

    if (json) {
      const entries = toDiffJson({
        actions: [], unmanaged: filteredUnmanaged,
        unboundAgents: filteredAgents, staleAgents: [],
        pins: [], channels: [],
      });
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log(`Imported ${importedCount} resource(s) into ${configPath}`);
      console.log("Run 'disclaw diff' to verify the updated config.");
    }
    return 0;
  } finally {
    await discord.destroy();
  }
}

function addThreadToChannel(doc: any, channels: any, parentName: string, threadName: string): void {
  // Search through channel entries to find the parent channel
  for (let i = 0; i < channels.items.length; i++) {
    const item = channels.items[i];
    const value = item.value ?? item;

    // Check if this is a standalone channel
    const nameNode = value.get?.("name");
    if (nameNode === parentName) {
      let threadsNode = value.get?.("threads");
      if (!threadsNode) {
        value.set("threads", doc.createNode([threadName]));
      } else {
        threadsNode.add(threadName);
      }
      return;
    }

    // Check if this is a category group
    const categoryChannels = value.get?.("channels");
    if (categoryChannels) {
      for (let j = 0; j < categoryChannels.items.length; j++) {
        const ch = categoryChannels.items[j].value ?? categoryChannels.items[j];
        if (ch.get?.("name") === parentName) {
          let threadsNode = ch.get?.("threads");
          if (!threadsNode) {
            ch.set("threads", doc.createNode([threadName]));
          } else {
            threadsNode.add(threadName);
          }
          return;
        }
      }
    }
  }
}
