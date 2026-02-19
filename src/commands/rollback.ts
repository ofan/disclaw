// src/commands/rollback.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseConfig } from "../parser.ts";
import { reconcile } from "../reconciler.ts";
import { formatActions, formatDriftWarnings } from "../format.ts";
import { DiscordProvider } from "../providers/discord.ts";
import { resolveOpenClawProvider, resolveDiscordToken } from "../providers/openclaw.ts";
import type { OpenClawProvider } from "../providers/openclaw.ts";
import { loadLatestSnapshot, saveSnapshot } from "../snapshot.ts";
import type {
  DesiredChannel,
  DesiredChannelEntry,
  DesiredState,
  GatewayOptions,
  OpenClawState,
  Snapshot,
} from "../types.ts";

export async function rollbackCommand(
  configPath: string,
  yes: boolean,
  json: boolean = false,
  gwOpts?: GatewayOptions,
  snapshotDir?: string,
): Promise<number> {
  const snapshot = await loadLatestSnapshot(snapshotDir);
  if (!snapshot) {
    if (json) {
      console.log(JSON.stringify({ error: "No snapshot found" }));
    } else {
      console.error("No snapshot found. Nothing to rollback to.");
    }
    return 1;
  }
  if (!json) console.log(`Found snapshot from ${snapshot.timestamp} (config hash: ${snapshot.configHash})`);

  const raw = readFileSync(configPath, "utf-8");
  const desired = parseConfig(raw);

  const token = await resolveDiscordToken(gwOpts);
  const discord = new DiscordProvider(token, desired.guild);
  await discord.login();

  try {
    const currentDiscord = await discord.fetch();

    let currentOC: OpenClawState = { bindings: [] };
    let ocProvider: OpenClawProvider | null = null;
    const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
    if (resolved) {
      ocProvider = resolved.provider;
      currentOC = await ocProvider.fetch();
    }

    // Build "desired = snapshot state" and reconcile against current
    const snapshotDesired = snapshotToDesired(snapshot, desired);
    const { actions } = reconcile(snapshotDesired, currentDiscord, currentOC);

    // Show drift warnings
    const { actions: originalActions } = reconcile(desired, snapshot.discord, snapshot.openclaw);

    if (json) {
      const entries = actions.map((a) => ({
        op: a.type, type: a.resourceType, name: a.name,
        ...(a.details?.before ? { before: a.details.before } : {}),
        ...(a.details?.after ? { after: a.details.after } : {}),
      }));
      if (!yes) {
        console.log(JSON.stringify(entries, null, 2));
        return actions.some((a) => a.type !== "noop") ? 2 : 0;
      }
    }

    if (!json) {
      const driftWarnings = formatDriftWarnings(originalActions, actions);
      if (driftWarnings) console.log(driftWarnings);

      console.log("Rollback would apply:");
      console.log(formatActions(actions));
    }

    const changes = actions.filter((a) => a.type !== "noop");
    if (changes.length === 0) {
      if (!json) console.log("Current state already matches snapshot. No rollback needed.");
      return 0;
    }

    if (!yes) {
      if (!json) console.log("Dry-run mode. Use --yes to rollback.");
      return 0;
    }

    // Pre-rollback snapshot (so rollback is reversible)
    const configHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    const preRollbackSnapshot = {
      timestamp: new Date().toISOString(),
      configHash: `pre-rollback-${configHash}`,
      discord: currentDiscord,
      openclaw: currentOC,
    };
    const preRollbackPath = await saveSnapshot(preRollbackSnapshot, snapshotDir);
    if (!json) console.log(`Pre-rollback snapshot saved: ${preRollbackPath}`);

    // Apply rollback
    if (!json) console.log("Rolling back Discord changes...");
    await discord.apply(actions.filter((a) => a.type !== "noop" && a.resourceType !== "binding"));

    if (ocProvider) {
      const bindingActions = actions.filter((a) => a.resourceType === "binding");
      if (bindingActions.length > 0) {
        if (!json) console.log("Rolling back OpenClaw bindings...");
        await ocProvider.apply(bindingActions, { guildId: desired.guild });
      }
    }

    // Verify
    if (!json) console.log("Verifying rollback...");
    const verified = await discord.verify(snapshot.discord);
    if (!verified) {
      if (json) {
        console.log(JSON.stringify({ error: "Rollback verification failed" }));
      } else {
        console.error("⚠ Rollback verification failed. Check state manually.");
      }
      return 1;
    }

    if (json) {
      const entries = actions.map((a) => ({
        op: a.type, type: a.resourceType, name: a.name,
        status: a.type === "noop" ? "skipped" : "applied",
      }));
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log("✓ Rollback complete.");
    }
    return 0;
  } finally {
    await discord.destroy();
  }
}

function snapshotToDesired(snapshot: Snapshot, originalConfig: DesiredState): DesiredState {
  // Handle both old snapshots (category: singular) and new (categories: array)
  const snapshotDiscord = snapshot.discord as unknown as Record<string, unknown>;
  const categories: Array<{ id: string; name: string }> =
    Array.isArray(snapshotDiscord.categories)
      ? (snapshotDiscord.categories as Array<{ id: string; name: string }>)
      : snapshotDiscord.category
        ? [snapshotDiscord.category as { id: string; name: string }]
        : [];

  // Build a map of categoryId → categoryName for channel grouping
  const categoryNameById = new Map<string, string>();
  for (const cat of categories) {
    categoryNameById.set(cat.id, cat.name);
  }

  // Group channels by category
  const channelsByCategory = new Map<string, DesiredChannel[]>();
  const topLevelChannels: DesiredChannel[] = [];

  for (const ch of snapshot.discord.channels) {
    const catName = ch.categoryId ? categoryNameById.get(ch.categoryId) : undefined;
    const threads = snapshot.discord.threads
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

  // Build agents map from bindings
  const agents: Record<string, string> = {};
  for (const b of snapshot.openclaw.bindings) {
    const ch = snapshot.discord.channels.find((c) => c.id === b.match.peer.id);
    agents[b.agentId] = ch?.name ?? b.match.peer.id;
  }

  return {
    version: 1,
    managedBy: "disclaw",
    guild: originalConfig.guild,
    channels: channelEntries,
    ...(Object.keys(agents).length > 0 ? { openclaw: { agents } } : {}),
  };
}
