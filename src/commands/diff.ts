// src/commands/diff.ts
import { readFileSync } from "node:fs";
import { parseConfig, flattenDesiredState } from "../parser.ts";
import { reconcile } from "../reconciler.ts";
import {
  formatActions,
  formatUnmanaged,
  formatPinSummary,
  formatUnboundAgents,
  formatStaleAgents,
  toDiffJson,
} from "../format.ts";
import { filterActions, filterUnmanaged, filterAgents, filterSummary } from "../filter.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type { DesiredState, OpenClawState, ResourceTypeFilter, GatewayOptions } from "../types.ts";

export async function diffCommand(
  configPath: string,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  gwOpts?: GatewayOptions,
  serverFilter?: string,
): Promise<number> {
  const raw = readFileSync(configPath, "utf-8");
  const config = parseConfig(raw);

  // Validate --server filter
  if (serverFilter && !config.servers[serverFilter]) {
    const names = Object.keys(config.servers).join(", ");
    console.error(`Error: Server "${serverFilter}" not found. Available: ${names}`);
    return 1;
  }

  // Show config-level warnings once at the top
  if (config.warnings?.length && !json) {
    for (const w of config.warnings) console.log(`\u26A0 ${w}`);
  }

  // Resolve Discord token once
  const token = await resolveDiscordToken(gwOpts);

  // Resolve OpenClaw once (shared across servers)
  let openclawState: OpenClawState = { bindings: [] };
  let ocAgents: string[] = [];
  let ocAvailable = false;
  const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
  if (resolved) {
    ocAvailable = true;
    if (!json) console.log(`OpenClaw: ${resolved.mode === "api" ? "gateway API" : "CLI"}`);
    openclawState = await resolved.provider.fetch();
    try {
      ocAgents = await resolved.provider.fetchAgents();
    } catch {
      // agents list may not be available
    }
  } else {
    if (!json) console.log("\u26A0 OpenClaw not available \u2014 skipping binding check");
  }

  const serverEntries = serverFilter
    ? [[serverFilter, config.servers[serverFilter]] as const]
    : (Object.entries(config.servers) as [string, typeof config.servers[string]][]);

  const allJsonEntries: unknown[] = [];

  for (const [serverName, server] of serverEntries) {
    // Per-server header (skip for single-server configs)
    if (!config.singleServer && !json) {
      console.log(`\n\u2500\u2500 ${serverName} \u2500\u2500`);
    }

    if (!json) {
      console.log(`Guild: ${server.guild}`);
    }

    const discord = new DiscordProvider(token, server.guild);
    await discord.login();

    let discordState;
    try {
      discordState = await discord.fetch();
    } finally {
      await discord.destroy();
    }

    // Construct DesiredState for this server
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: server.guild,
      channels: server.channels,
      openclaw: server.openclaw,
    };

    // Reconcile
    const { actions, unmanaged } = reconcile(desired, discordState, openclawState);

    // Compute agent lists (per-server)
    const flat = flattenDesiredState(desired);
    const configAgentNames = new Set(flat.bindings.map((b) => b.agentName));
    const unboundAgents = ocAvailable ? ocAgents.filter((a) => !configAgentNames.has(a)) : [];
    const staleAgents = ocAvailable
      ? flat.bindings.map((b) => b.agentName).filter((a) => !ocAgents.includes(a))
      : [];

    // Routing health check per server
    const allowlistWarnings: string[] = [];
    if (resolved) {
      try {
        const routingConfig = await resolved.provider.fetchRoutingConfig(server.guild);
        const allowedChannelIds = new Set(
          Object.entries(routingConfig.channels ?? {})
            .filter(([, entry]) => entry.allow === true)
            .map(([id]) => id),
        );
        for (const binding of openclawState.bindings) {
          if (binding.match.channel !== "discord") continue;
          const channelId = binding.match.peer.id;
          // Only check bindings for this guild's channels
          if (!discordState.channels.some((c) => c.id === channelId)) continue;
          if (!allowedChannelIds.has(channelId)) {
            const channelName = discordState.channels.find((c) => c.id === channelId)?.name ?? channelId;
            allowlistWarnings.push(
              `  \u26A0 "${channelName}" is bound to ${binding.agentId} but not allowlisted \u2014 bot cannot respond`,
            );
          }
        }
      } catch {
        // routing config read failed — skip health check
      }
    }

    // Apply filters
    const filteredActions = filterActions(actions, filter);
    const filteredUnmanaged = filterUnmanaged(unmanaged, filter);
    const filteredUnbound = filterAgents(unboundAgents, filter);
    const filteredStale = filterAgents(staleAgents, filter);

    if (json) {
      const entries = toDiffJson({
        actions: filteredActions,
        unmanaged: filteredUnmanaged,
        unboundAgents: filteredUnbound,
        staleAgents: filteredStale,
        pins: discordState.pins,
        channels: discordState.channels,
      });
      // Add server field to each entry
      for (const entry of entries) {
        (entry as unknown as Record<string, unknown>).server = serverName;
      }
      allJsonEntries.push(...entries);
    } else {
      // Human output
      console.log(formatActions(filteredActions));

      if (filteredUnmanaged.length > 0) {
        console.log(formatUnmanaged(filteredUnmanaged));
      }

      if (discordState.pins.length > 0 && !filter) {
        console.log(formatPinSummary(discordState.pins, discordState.channels));
      }

      if (filteredUnbound.length > 0) {
        console.log(formatUnboundAgents(filteredUnbound));
      }
      if (filteredStale.length > 0) {
        console.log(formatStaleAgents(filteredStale));
      }

      if (allowlistWarnings.length > 0) {
        console.log("\nRouting health:");
        for (const warning of allowlistWarnings) {
          console.log(warning);
        }
      }

      // Filter summary per server
      const totalCount = actions.length + unmanaged.length + unboundAgents.length + staleAgents.length;
      const showingCount = filteredActions.length + filteredUnmanaged.length + filteredUnbound.length + filteredStale.length;
      const summary = filterSummary(showingCount, totalCount, filter);
      if (summary) console.log(summary);
    }
  }

  if (json) {
    console.log(JSON.stringify(allJsonEntries, null, 2));
  }

  return 0;
}
