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
import type { OpenClawState, ResourceTypeFilter, GatewayOptions } from "../types.ts";

export async function diffCommand(
  configPath: string,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  gwOpts?: GatewayOptions,
): Promise<number> {
  const raw = readFileSync(configPath, "utf-8");
  const desired = parseConfig(raw);
  if (desired.warnings?.length) {
    for (const w of desired.warnings) console.log(`\u26A0 ${w}`);
  }
  console.log(`Guild: ${desired.guild}`);

  const token = await resolveDiscordToken(gwOpts);
  const discord = new DiscordProvider(token, desired.guild);
  await discord.login();

  let discordState;
  try {
    discordState = await discord.fetch();
  } finally {
    await discord.destroy();
  }

  let openclawState: OpenClawState = { bindings: [] };
  let ocAgents: string[] = [];
  let ocAvailable = false;
  let allowlistWarnings: string[] = [];
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

    // Check routing gates: warn if bound channels are not allowlisted
    try {
      const routingConfig = await resolved.provider.fetchRoutingConfig(desired.guild);
      const allowedChannelIds = new Set(
        Object.entries(routingConfig.channels ?? {})
          .filter(([, entry]) => entry.allow === true)
          .map(([id]) => id),
      );
      for (const binding of openclawState.bindings) {
        if (binding.match.channel !== "discord") continue;
        const channelId = binding.match.peer.id;
        if (!allowedChannelIds.has(channelId)) {
          const channelName = discordState.channels.find((c) => c.id === channelId)?.name ?? channelId;
          allowlistWarnings.push(
            `  \u26A0 "${channelName}" is bound to ${binding.agentId} but not allowlisted — bot cannot respond`,
          );
        }
      }
    } catch {
      // routing config read failed — skip health check
    }
  } else {
    if (!json) console.log("⚠ OpenClaw not available — skipping binding check");
  }

  const { actions, unmanaged } = reconcile(desired, discordState, openclawState);

  // Compute agent lists
  const flat = flattenDesiredState(desired);
  const configAgentNames = new Set(flat.bindings.map((b) => b.agentName));
  const unboundAgents = ocAvailable ? ocAgents.filter((a) => !configAgentNames.has(a)) : [];
  const staleAgents = ocAvailable
    ? flat.bindings.map((b) => b.agentName).filter((a) => !ocAgents.includes(a))
    : [];

  // Apply filters
  const filteredActions = filterActions(actions, filter);
  const filteredUnmanaged = filterUnmanaged(unmanaged, filter);
  const filteredUnbound = filterAgents(unboundAgents, filter);
  const filteredStale = filterAgents(staleAgents, filter);

  // JSON output
  if (json) {
    const entries = toDiffJson({
      actions: filteredActions,
      unmanaged: filteredUnmanaged,
      unboundAgents: filteredUnbound,
      staleAgents: filteredStale,
      pins: discordState.pins,
      channels: discordState.channels,
    });
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

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

  // Filter summary
  const totalCount = actions.length + unmanaged.length + unboundAgents.length + staleAgents.length;
  const showingCount = filteredActions.length + filteredUnmanaged.length + filteredUnbound.length + filteredStale.length;
  const summary = filterSummary(showingCount, totalCount, filter);
  if (summary) console.log(summary);

  return 0;
}
