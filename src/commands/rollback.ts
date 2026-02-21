// src/commands/rollback.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseConfig } from "../parser.ts";
import { reconcile } from "../reconciler.ts";
import { formatActions, formatDriftWarnings } from "../format.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type { OpenClawProvider } from "../providers/openclaw.ts";
import { loadSnapshot, saveSnapshot } from "../snapshot.ts";
import type {
  DesiredChannel,
  DesiredChannelEntry,
  DesiredState,
  DiscordState,
  GatewayOptions,
  MultiServerSnapshot,
  OpenClawState,
  SnapshotOptions,
} from "../types.ts";
import { resolveSnapshotPath } from "../types.ts";

export async function rollbackCommand(
  configPath: string,
  yes: boolean,
  json: boolean = false,
  gwOpts?: GatewayOptions,
  snapOpts?: SnapshotOptions,
  serverFilter?: string,
): Promise<number> {
  // Derive snapshot path
  const snapshotPath = snapOpts?.enabled !== false && snapOpts?.path
    ? snapOpts.path
    : resolveSnapshotPath(configPath);

  const snapshot = loadSnapshot(snapshotPath);
  if (!snapshot) {
    if (json) {
      console.log(JSON.stringify({ error: "No snapshot found" }));
    } else {
      console.error(`No snapshot found at ${snapshotPath}. Nothing to rollback to.`);
    }
    return 1;
  }
  if (!json) console.log(`Found snapshot from ${snapshot.timestamp} (config hash: ${snapshot.configHash})`);

  const raw = readFileSync(configPath, "utf-8");
  const config = parseConfig(raw);

  // Validate --server filter against snapshot
  const snapshotServerNames = Object.keys(snapshot.servers);
  if (serverFilter) {
    if (!snapshot.servers[serverFilter]) {
      const names = snapshotServerNames.join(", ");
      if (json) {
        console.log(JSON.stringify({ error: `Server "${serverFilter}" not in snapshot. Available: ${names}` }));
      } else {
        console.error(`Error: Server "${serverFilter}" not in snapshot. Available: ${names}`);
      }
      return 1;
    }
  }

  const serverEntries = serverFilter
    ? [[serverFilter, snapshot.servers[serverFilter]] as const]
    : (Object.entries(snapshot.servers) as [string, typeof snapshot.servers[string]][]);

  // Resolve Discord token once
  const token = await resolveDiscordToken(gwOpts);

  // Resolve OpenClaw once (shared across servers)
  let currentOC: OpenClawState = { bindings: [] };
  let ocProvider: OpenClawProvider | null = null;
  const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
  if (resolved) {
    ocProvider = resolved.provider;
    if (!json) console.log(`OpenClaw: ${resolved.mode === "api" ? "gateway API" : "CLI"}`);
    currentOC = await ocProvider.fetch();
  } else {
    if (!json) console.log("\u26a0 OpenClaw not available \u2014 bindings will be skipped");
  }

  // Collect current states for all servers (needed for pre-rollback snapshot + drift)
  const currentStates: Record<string, { guildId: string; discord: DiscordState }> = {};
  const serverActions: Array<{
    serverName: string;
    guildId: string;
    actions: ReturnType<typeof reconcile>["actions"];
    driftWarnings: string;
  }> = [];

  const allJsonEntries: unknown[] = [];

  for (const [serverName, serverSnapshot] of serverEntries) {
    if (serverEntries.length > 1 && !json) {
      console.log(`\n\u2500\u2500 ${serverName} \u2500\u2500`);
    }

    const discord = new DiscordProvider(token, serverSnapshot.guildId);
    await discord.login();

    try {
      const currentDiscord = await discord.fetch();
      currentStates[serverName] = { guildId: serverSnapshot.guildId, discord: currentDiscord };

      // Build "desired = snapshot state" for this server
      const snapshotDesired = snapshotToDesired(serverSnapshot.discord, serverSnapshot.guildId, snapshot.openclaw);

      // Reconcile snapshot desired vs current
      const { actions } = reconcile(snapshotDesired, currentDiscord, currentOC);

      // Compute drift warnings: what the current config would have done against the snapshot state
      let driftWarnings = "";
      const serverConfig = config.servers[serverName];
      if (serverConfig) {
        const desired: DesiredState = {
          version: 1,
          managedBy: "disclaw",
          guild: serverConfig.guild,
          channels: serverConfig.channels,
          openclaw: serverConfig.openclaw,
        };
        const { actions: originalActions } = reconcile(desired, serverSnapshot.discord, snapshot.openclaw);
        driftWarnings = formatDriftWarnings(originalActions, actions);
      }

      serverActions.push({ serverName, guildId: serverSnapshot.guildId, actions, driftWarnings });

      // JSON dry-run output (collected, printed at end)
      if (json && !yes) {
        const entries = actions.map((a) => ({
          op: a.type, type: a.resourceType, name: a.name,
          ...(a.details?.before ? { before: a.details.before } : {}),
          ...(a.details?.after ? { after: a.details.after } : {}),
          server: serverName,
        }));
        allJsonEntries.push(...entries);
        continue;
      }

      // Human-readable output
      if (!json) {
        if (driftWarnings) console.log(driftWarnings);
        console.log("Rollback would apply:");
        console.log(formatActions(actions));
      }
    } finally {
      await discord.destroy();
    }
  }

  // JSON dry-run: print collected entries and exit
  if (json && !yes) {
    console.log(JSON.stringify(allJsonEntries, null, 2));
    const hasChanges = allJsonEntries.some((e) => (e as Record<string, unknown>).op !== "noop");
    return hasChanges ? 2 : 0;
  }

  // Check if any server has changes
  const totalChanges = serverActions.reduce(
    (sum, s) => sum + s.actions.filter((a) => a.type !== "noop").length,
    0,
  );
  if (totalChanges === 0) {
    if (json) {
      console.log(JSON.stringify([]));
    } else {
      console.log("Current state already matches snapshot. No rollback needed.");
    }
    return 0;
  }

  if (!yes) {
    if (!json) console.log("Dry-run mode. Use --yes to rollback.");
    return 0;
  }

  // Save pre-rollback snapshot (combined, all servers' current state)
  const configHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
  if (snapOpts?.enabled !== false) {
    const preRollback: MultiServerSnapshot = {
      timestamp: new Date().toISOString(),
      configHash: `pre-rollback-${configHash}`,
      servers: currentStates,
      openclaw: currentOC,
    };
    saveSnapshot(preRollback, snapshotPath);
    if (!json) console.log(`Pre-rollback snapshot saved: ${snapshotPath}`);
  }

  // Apply rollback per server
  const errors: Array<{ server: string; error: string }> = [];

  for (const { serverName, guildId, actions } of serverActions) {
    const changes = actions.filter((a) => a.type !== "noop");
    if (changes.length === 0) continue;

    if (serverActions.length > 1 && !json) {
      console.log(`\nRolling back ${serverName}...`);
    }

    const discord = new DiscordProvider(token, guildId);
    await discord.login();

    try {
      // Apply Discord changes
      const discordActions = actions.filter(
        (a) => a.type !== "noop" && a.resourceType !== "binding",
      );
      if (discordActions.length > 0) {
        if (!json) console.log("Rolling back Discord changes...");
        try {
          await discord.apply(discordActions);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push({ server: serverName, error: `Discord rollback failed: ${msg}` });
          if (!json) {
            console.error(`\u26a0 ${serverName}: Discord rollback failed. Error: ${msg}`);
          }
          continue;
        }
      }

      // Apply OpenClaw binding changes
      if (ocProvider) {
        const bindingActions = actions.filter(
          (a) => a.type !== "noop" && a.resourceType === "binding",
        );
        if (bindingActions.length > 0) {
          if (!json) console.log("Rolling back OpenClaw bindings...");
          try {
            await ocProvider.apply(bindingActions, { guildId });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ server: serverName, error: `OpenClaw rollback failed: ${msg}` });
            if (!json) {
              console.error(`\u26a0 ${serverName}: OpenClaw rollback failed. Error: ${msg}`);
            }
            continue;
          }
        }
      }

      // Verify
      const serverSnapshot = snapshot.servers[serverName];
      if (!json) console.log("Verifying rollback...");
      const verified = await discord.verify(serverSnapshot.discord);
      if (!verified) {
        errors.push({ server: serverName, error: "Rollback verification failed" });
        if (!json) {
          console.error(`\u26a0 ${serverName}: Rollback verification failed. Check state manually.`);
        }
        continue;
      }

      // Per-server success output
      if (json) {
        const entries = actions.map((a) => ({
          op: a.type, type: a.resourceType, name: a.name,
          status: a.type === "noop" ? "skipped" : "applied",
          server: serverName,
        }));
        allJsonEntries.push(...entries);
      } else {
        console.log("\u2713 Rollback complete.");
      }
    } finally {
      await discord.destroy();
    }
  }

  // Final output
  if (json) {
    if (errors.length > 0) {
      console.log(JSON.stringify({ errors, results: allJsonEntries }, null, 2));
    } else {
      console.log(JSON.stringify(allJsonEntries, null, 2));
    }
  }

  if (errors.length > 0) {
    if (!json) {
      console.error(`\n\u26a0 ${errors.length} server(s) failed during rollback.`);
    }
    return 1;
  }

  if (!json) {
    console.log("\n\u2713 All rollbacks complete.");
  }

  return 0;
}

function snapshotToDesired(discordState: DiscordState, guildId: string, openclawState: OpenClawState): DesiredState {
  // Handle both old snapshots (category: singular) and new (categories: array)
  const snapshotDiscord = discordState as unknown as Record<string, unknown>;
  const categories: Array<{ id: string; name: string }> =
    Array.isArray(snapshotDiscord.categories)
      ? (snapshotDiscord.categories as Array<{ id: string; name: string }>)
      : snapshotDiscord.category
        ? [snapshotDiscord.category as { id: string; name: string }]
        : [];

  // Build a map of categoryId -> categoryName for channel grouping
  const categoryNameById = new Map<string, string>();
  for (const cat of categories) {
    categoryNameById.set(cat.id, cat.name);
  }

  // Group channels by category
  const channelsByCategory = new Map<string, DesiredChannel[]>();
  const topLevelChannels: DesiredChannel[] = [];

  for (const ch of discordState.channels) {
    const catName = ch.categoryId ? categoryNameById.get(ch.categoryId) : undefined;
    const threads = discordState.threads
      .filter((th) => th.parentChannelId === ch.id)
      .map((th) => th.name);

    const desiredCh: DesiredChannel = {
      name: ch.name,
      ...(ch.topic ? { topic: ch.topic } : {}),
      ...(ch.restricted ? { restricted: true } : {}),
      ...(threads.length > 0 ? { threads } : {}),
    };

    if (catName) {
      const list = channelsByCategory.get(catName) ?? [];
      list.push(desiredCh);
      channelsByCategory.set(catName, list);
    } else {
      topLevelChannels.push(desiredCh);
    }
  }

  // Build channel entries
  const channelEntries: DesiredChannelEntry[] = [];

  // Top-level channels first
  for (const ch of topLevelChannels) {
    channelEntries.push(ch);
  }

  // Then category groups
  for (const cat of categories) {
    const channels = channelsByCategory.get(cat.name) ?? [];
    if (channels.length > 0) {
      channelEntries.push({ category: cat.name, channels });
    }
  }

  // Build agents map from bindings (filter to this guild's channels only)
  const agents: Record<string, string> = {};
  const channelIds = new Set(discordState.channels.map((c) => c.id));
  for (const b of openclawState.bindings) {
    if (b.match.channel !== "discord") continue;
    if (!channelIds.has(b.match.peer.id)) continue; // skip other guilds
    const ch = discordState.channels.find((c) => c.id === b.match.peer.id);
    agents[b.agentId] = ch?.name ?? b.match.peer.id;
  }

  return {
    version: 1,
    managedBy: "disclaw",
    guild: guildId,
    channels: channelEntries,
    ...(Object.keys(agents).length > 0 ? { openclaw: { agents } } : {}),
  };
}
