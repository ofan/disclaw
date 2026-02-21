// src/commands/apply.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseConfig } from "../parser.ts";
import { reconcile } from "../reconciler.ts";
import { formatActions, toDiffJson } from "../format.ts";
import { filterActions, filterSummary } from "../filter.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type { OpenClawProvider } from "../providers/openclaw.ts";
import { saveSnapshot } from "../snapshot.ts";
import type {
  DesiredState,
  DiscordState,
  MultiServerSnapshot,
  OpenClawState,
  ResourceTypeFilter,
  GatewayOptions,
  SnapshotOptions,
  ServerConfig,
} from "../types.ts";

export async function applyCommand(
  configPath: string,
  yes: boolean,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  prune: boolean = false,
  gwOpts?: GatewayOptions,
  snapOpts?: SnapshotOptions,
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
  if (config.warnings?.length) {
    for (const w of config.warnings) {
      if (!json) console.log(`\u26A0 ${w}`);
    }
  }

  const configHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);

  // Resolve Discord token once (shared across servers)
  const token = await resolveDiscordToken(gwOpts);

  // Resolve OpenClaw once (shared across servers)
  let openclawState: OpenClawState = { bindings: [] };
  let ocProvider: OpenClawProvider | null = null;
  const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
  if (resolved) {
    ocProvider = resolved.provider;
    if (!json) console.log(`OpenClaw: ${resolved.mode === "api" ? "gateway API" : "CLI"}`);
    openclawState = await ocProvider.fetch();
  } else {
    if (!json) console.log("\u26A0 OpenClaw not available \u2014 bindings will be skipped");
  }

  const serverEntries = serverFilter
    ? [[serverFilter, config.servers[serverFilter]] as const]
    : (Object.entries(config.servers) as [string, ServerConfig][]);

  // Fetch all servers' Discord state (needed for combined snapshot + reconcile)
  const serverStates: Record<string, { guildId: string; discord: DiscordState }> = {};
  for (const [name, server] of serverEntries) {
    const discord = new DiscordProvider(token, server.guild);
    await discord.login();
    try {
      const discordState = await discord.fetch();
      serverStates[name] = { guildId: server.guild, discord: discordState };
    } finally {
      await discord.destroy();
    }
  }

  // Save combined snapshot before any mutation (only when actually applying)
  let snapshotSaved = false;
  if (snapOpts?.enabled !== false && yes) {
    const snapshot: MultiServerSnapshot = {
      timestamp: new Date().toISOString(),
      configHash,
      servers: serverStates,
      openclaw: openclawState,
    };
    saveSnapshot(snapshot, snapOpts!.path);
    snapshotSaved = true;
    if (!json) console.log(`Snapshot saved: ${snapOpts!.path}`);
  }

  // Per-server reconcile + apply loop
  const errors: Array<{ server: string; error: string }> = [];
  const allJsonEntries: unknown[] = [];

  for (const [serverName, server] of serverEntries) {
    // Per-server header (skip for single-server configs)
    if (!config.singleServer && !json) {
      console.log(`\n\u2500\u2500 ${serverName} \u2500\u2500`);
    }

    const state = serverStates[serverName];
    const discordState = state.discord;

    // Construct DesiredState for this server
    const desired: DesiredState = {
      version: 1,
      managedBy: "disclaw",
      guild: server.guild,
      channels: server.channels,
      openclaw: server.openclaw,
    };

    const { actions } = reconcile(desired, discordState, openclawState, { prune });
    const filteredActions = filterActions(actions, filter);

    // Dry-run JSON output
    if (json && !yes) {
      const entries = toDiffJson({
        actions: filteredActions, unmanaged: [], unboundAgents: [], staleAgents: [],
        pins: [], channels: [],
      });
      for (const entry of entries) {
        (entry as unknown as Record<string, unknown>).server = serverName;
      }
      allJsonEntries.push(...entries);
      continue;
    }

    // Human-readable diff output
    if (!json) {
      console.log(formatActions(filteredActions));
      const summary = filterSummary(filteredActions.length, actions.length, filter);
      if (summary) console.log(summary);
    }

    const changes = filteredActions.filter((a) => a.type !== "noop");
    const bindingActions = filteredActions.filter((a) => a.resourceType === "binding");

    // No changes — but routing gates may still need syncing
    if (changes.length === 0) {
      if (yes && bindingActions.length > 0 && ocProvider) {
        // Create a fresh DiscordProvider to resolve channel IDs
        const discord = new DiscordProvider(token, server.guild);
        await discord.login();
        try {
          for (const action of bindingActions) {
            if (action.details?.after) {
              const channelRef = (action.details.after as Record<string, string>).channelRef;
              const channelId = await discord.getChannelIdByName(channelRef);
              if (channelId) {
                (action.details.after as Record<string, string>).resolvedChannelId = channelId;
              }
            }
          }
          if (!json) console.log("Syncing routing gates...");
          await ocProvider.apply(bindingActions, { guildId: server.guild });
          if (!json) console.log("\u2713 Routing gates synced.");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ server: serverName, error: `Routing gate sync failed: ${msg}` });
          if (!json) console.error(`\u26A0 ${serverName}: Routing gate sync failed. Error: ${msg}`);
        } finally {
          await discord.destroy();
        }
      } else {
        if (!json) console.log("No changes to apply.");
      }
      continue;
    }

    if (!yes) {
      // dry-run output already shown above
      continue;
    }

    // Create a fresh DiscordProvider for mutations
    const discord = new DiscordProvider(token, server.guild);
    await discord.login();

    try {
      // Apply Discord changes (creates/updates first, then deletes)
      const discordActions = filteredActions.filter(
        (a) => a.type !== "noop" && a.resourceType !== "binding",
      );
      const deleteActions = discordActions.filter((a) => a.type === "delete");
      const nonDeleteActions = discordActions.filter((a) => a.type !== "delete");

      let appliedCount = 0;
      try {
        if (nonDeleteActions.length > 0) {
          if (!json) console.log("Applying Discord changes...");
          await discord.apply(nonDeleteActions);
          appliedCount += nonDeleteActions.length;
        }

        if (deleteActions.length > 0) {
          if (!json) {
            console.log(`\u26A0 DELETING ${deleteActions.length} resource(s) \u2014 THIS IS PERMANENT`);
          }
          await discord.apply(deleteActions);
          appliedCount += deleteActions.length;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ server: serverName, error: `Discord apply failed after ${appliedCount}/${discordActions.length}: ${msg}` });
        if (!json) {
          console.error(`\n\u26A0 ${serverName}: Apply failed after ${appliedCount}/${discordActions.length} Discord changes.`);
          console.error(`  Error: ${msg}`);
          if (snapshotSaved) console.error(`  Snapshot saved: ${snapOpts!.path}`);
          console.error(`  Rollback: disclaw rollback --yes`);
        }
        continue;
      }

      // Apply OpenClaw changes (resolve channel IDs first)
      if (bindingActions.length > 0 && ocProvider) {
        for (const action of bindingActions) {
          if (action.details?.after) {
            const channelRef = (action.details.after as Record<string, string>).channelRef;
            const channelId = await discord.getChannelIdByName(channelRef);
            if (channelId) {
              (action.details.after as Record<string, string>).resolvedChannelId = channelId;
            }
          }
        }
        try {
          if (!json) console.log("Applying OpenClaw binding changes...");
          await ocProvider.apply(bindingActions, { guildId: server.guild });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ server: serverName, error: `OpenClaw apply failed: ${msg}` });
          if (!json) {
            console.error(`\n\u26A0 ${serverName}: OpenClaw apply failed. Discord changes were applied successfully.`);
            console.error(`  Error: ${msg}`);
            if (snapshotSaved) console.error(`  Snapshot saved: ${snapOpts!.path}`);
            console.error(`  Rollback: disclaw rollback --yes`);
          }
          continue;
        }
      }

      // Verify
      if (!json) console.log("Verifying...");
      const verified = await discord.verify(discordState);
      if (!verified) {
        errors.push({ server: serverName, error: "Discord verification failed" });
        if (!json) {
          console.error(`\u26A0 ${serverName}: Discord verification failed. Rollback available.`);
          console.error(`  Run: disclaw rollback --yes`);
        }
        continue;
      }
      if (ocProvider) {
        const ocVerified = await ocProvider.verify(openclawState);
        if (!ocVerified) {
          errors.push({ server: serverName, error: "OpenClaw verification failed" });
          if (!json) {
            console.error(`\u26A0 ${serverName}: OpenClaw verification failed. Rollback available.`);
            console.error(`  Run: disclaw rollback --yes`);
          }
          continue;
        }
      }

      // Per-server success output
      if (json) {
        const entries = filteredActions.map((a) => ({
          op: a.type, type: a.resourceType, name: a.name,
          status: a.type === "noop" ? "skipped" : "applied",
          server: serverName,
        }));
        allJsonEntries.push(...entries);
      } else {
        console.log("\u2713 Apply complete. All changes verified.");
        if (deleteActions.length > 0) {
          console.log("  Note: deleted channels cannot be fully restored via rollback.");
        }
      }
    } finally {
      await discord.destroy();
    }
  }

  // Dry-run JSON output (collected across all servers)
  if (json && !yes) {
    console.log(JSON.stringify(allJsonEntries, null, 2));
    const hasChanges = allJsonEntries.some((e) => (e as Record<string, unknown>).op !== "noop");
    return hasChanges ? 2 : 0;
  }

  // Dry-run footer
  if (!yes) {
    if (!json) console.log("Dry-run mode. Use --yes to apply changes.");
    return 0;
  }

  // JSON success output (collected across all servers)
  if (json && errors.length === 0) {
    console.log(JSON.stringify(allJsonEntries, null, 2));
  }

  // Report errors at end
  if (errors.length > 0) {
    if (json) {
      console.log(JSON.stringify({ errors, results: allJsonEntries }, null, 2));
    } else {
      console.error(`\n\u26A0 ${errors.length} server(s) failed. Rollback: disclaw rollback --yes`);
    }
    return 1;
  }

  if (!json) {
    console.log(`\nRollback available: disclaw rollback --yes`);
  }

  return 0;
}
