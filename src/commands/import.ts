// src/commands/import.ts
import { readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseConfig, flattenDesiredState } from "../parser.ts";
import { formatUnmanaged, formatUnboundAgents, toDiffJson } from "../format.ts";
import { filterUnmanaged, filterAgents, filterSummary } from "../filter.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type {
  DesiredState,
  DiscordState,
  UnmanagedResource,
  ResourceTypeFilter,
  GatewayOptions,
  ServerConfig,
} from "../types.ts";

export async function importCommand(
  configPath: string,
  yes: boolean,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  gwOpts?: GatewayOptions,
  serverFilter?: string,
): Promise<number> {
  const raw = readFileSync(configPath, "utf-8");
  const config = parseConfig(raw);

  // Show config-level warnings once at the top
  if (config.warnings?.length && !json) {
    for (const w of config.warnings) console.log(`\u26A0 ${w}`);
  }

  // Validate --server filter
  if (serverFilter && !config.servers[serverFilter]) {
    const names = Object.keys(config.servers).join(", ");
    console.error(`Error: Server "${serverFilter}" not found. Available: ${names}`);
    return 1;
  }

  const serverEntries = serverFilter
    ? [[serverFilter, config.servers[serverFilter]] as const]
    : (Object.entries(config.servers) as [string, ServerConfig][]);

  // Resolve Discord token once (shared across servers)
  const token = await resolveDiscordToken(gwOpts);

  // Resolve OpenClaw once (shared across servers) — agents are global
  let allOcAgents: string[] = [];
  const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
  if (resolved) {
    try {
      allOcAgents = await resolved.provider.fetchAgents();
    } catch {
      // agents list may not be available
    }
  }

  // Per-server: fetch state + find unmanaged resources
  interface ServerImportResult {
    serverName: string;
    guildState: DiscordState;
    unmanaged: UnmanagedResource[];
    desiredChannelNames: Set<string>;
  }

  const serverResults: ServerImportResult[] = [];
  // Collect all binding agent names across servers for unbound agent detection
  const allConfigAgentNames = new Set<string>();

  for (const [serverName, server] of serverEntries) {
    // Construct DesiredState for this server
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: server.guild,
      channels: server.channels,
      openclaw: server.openclaw,
    };

    const flat = flattenDesiredState(desired);
    const desiredCategoryNames = new Set(flat.categories);
    const desiredChannelNames = new Set(flat.channels.map((c) => c.name));
    const desiredThreadKeys = new Set(
      flat.threads.map((t) => `${t.parentChannel}:${t.name}`),
    );

    // Track all agent names for unbound detection
    for (const b of flat.bindings) allConfigAgentNames.add(b.agentName);

    // Fetch guild state
    const discord = new DiscordProvider(token, server.guild);
    await discord.login();

    let guildState: DiscordState;
    try {
      guildState = await discord.fetch();
    } finally {
      await discord.destroy();
    }

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

    // Detect unmanaged channels
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

    // Detect unmanaged threads
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

    serverResults.push({ serverName, guildState, unmanaged, desiredChannelNames });
  }

  // Compute unbound agents (global — outside server loop)
  const unboundAgents = allOcAgents.filter((a) => !allConfigAgentNames.has(a));

  // Combine all unmanaged across servers for totals
  const allUnmanaged = serverResults.flatMap((r) => r.unmanaged);
  const filteredAllUnmanaged = filterUnmanaged(allUnmanaged, filter);
  const filteredAgents = filterAgents(unboundAgents, filter);

  // Per-server filtered unmanaged (for display + YAML writing)
  const perServerFiltered = serverResults.map((r) => ({
    ...r,
    filteredUnmanaged: filterUnmanaged(r.unmanaged, filter),
  }));

  // Check if there's anything to import
  const totalFilteredUnmanaged = perServerFiltered.reduce(
    (sum, r) => sum + r.filteredUnmanaged.length, 0,
  );

  if (totalFilteredUnmanaged === 0 && filteredAgents.length === 0) {
    if (json) {
      console.log("[]");
    } else {
      console.log("No unmanaged resources found. Nothing to import.");
    }
    return 0;
  }

  // JSON dry-run output
  if (json && !yes) {
    const entries = toDiffJson({
      actions: [], unmanaged: filteredAllUnmanaged,
      unboundAgents: filteredAgents, staleAgents: [],
      pins: [], channels: [],
    });
    // Add server field to each unmanaged entry
    for (const entry of entries) {
      const entryAny = entry as unknown as Record<string, unknown>;
      // Find which server this entry belongs to
      for (const r of perServerFiltered) {
        if (r.filteredUnmanaged.some((u) => u.name === entryAny.name && u.resourceType === entryAny.type)) {
          entryAny.server = r.serverName;
          break;
        }
      }
    }
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  // Human-readable output
  if (!json) {
    for (const r of perServerFiltered) {
      if (!config.singleServer) {
        console.log(`\n\u2500\u2500 ${r.serverName} \u2500\u2500`);
      }
      if (r.filteredUnmanaged.length > 0) {
        console.log(formatUnmanaged(r.filteredUnmanaged));
      } else {
        console.log("No unmanaged resources found.");
      }
    }

    if (filteredAgents.length > 0) {
      console.log(formatUnboundAgents(filteredAgents));
    }

    const totalCount = allUnmanaged.length + unboundAgents.length;
    const showingCount = totalFilteredUnmanaged + filteredAgents.length;
    const summary = filterSummary(showingCount, totalCount, filter);
    if (summary) console.log(summary);
  }

  if (!yes) {
    if (!json) console.log("Dry-run mode. Use --yes to import these resources into your config.");
    return 0;
  }

  // --- Write to YAML ---
  const doc = parseDocument(raw);
  let importedCount = 0;

  for (const r of perServerFiltered) {
    if (r.filteredUnmanaged.length === 0) continue;

    // Resolve YAML paths based on config shape
    const channelsPath = config.singleServer
      ? ["channels"]
      : ["servers", r.serverName, "channels"];

    const channels = doc.getIn(channelsPath) as any;

    // Track which channels belong to unmanaged categories so we nest them
    const channelsInUnmanagedCategories = new Set<string>();

    // Import categories first, nesting their channels inside
    for (const res of r.filteredUnmanaged) {
      if (res.resourceType !== "category") continue;

      const childChannels = r.guildState.channels.filter(
        (ch) => ch.categoryId === res.id && !r.desiredChannelNames.has(ch.name),
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

      const group: Record<string, unknown> = { category: res.name, channels: childEntries };
      channels.add(doc.createNode(group));
      importedCount += 1 + childEntries.length;
    }

    // Import standalone channels (skip ones already nested in a category)
    for (const res of r.filteredUnmanaged) {
      if (res.resourceType === "channel" && !channelsInUnmanagedCategories.has(res.id)) {
        const entry: Record<string, unknown> = { name: res.name };
        if (res.topic) entry.topic = res.topic;
        // Check if the source channel is restricted
        const srcCh = r.guildState.channels.find((ch) => ch.id === res.id);
        if (srcCh?.restricted) entry.restricted = true;
        if (srcCh?.private) entry.private = true;
        if (srcCh?.addBot) entry.addBot = true;
        channels.add(doc.createNode(entry));
        importedCount++;
      } else if (res.resourceType === "thread") {
        const parentChannel = r.guildState.channels.find(
          (ch) => r.guildState.threads.find(
            (th) => th.name === res.name && th.id === res.id,
          )?.parentChannelId === ch.id,
        );
        if (parentChannel) {
          addThreadToChannel(doc, channels, parentChannel.name, res.name);
          importedCount++;
        }
      }
    }
  }

  // Import unbound agents into openclaw.agents (global, once)
  if (filteredAgents.length > 0) {
    // For single-server, agents live at openclaw.agents
    // For multi-server, agents are per-server — pick the first server entry
    // (agents are global in OpenClaw, so we add them to the first server's openclaw section)
    const agentsPath = config.singleServer
      ? ["openclaw", "agents"]
      : ["servers", serverEntries[0][0], "openclaw", "agents"];

    let agentsNode = doc.getIn(agentsPath) as any;
    if (!agentsNode) {
      doc.setIn(agentsPath, doc.createNode({}));
      agentsNode = doc.getIn(agentsPath) as any;
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
      actions: [], unmanaged: filteredAllUnmanaged,
      unboundAgents: filteredAgents, staleAgents: [],
      pins: [], channels: [],
    });
    console.log(JSON.stringify(entries, null, 2));
  } else {
    console.log(`Imported ${importedCount} resource(s) into ${configPath}`);
    console.log("Run 'disclaw diff' to verify the updated config.");
  }
  return 0;
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
