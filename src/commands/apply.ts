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
import type { OpenClawState, ResourceTypeFilter, GatewayOptions } from "../types.ts";

export async function applyCommand(
  configPath: string,
  yes: boolean,
  filter: ResourceTypeFilter | null = null,
  json: boolean = false,
  prune: boolean = false,
  gwOpts?: GatewayOptions,
  snapshotDir?: string,
): Promise<number> {
  const raw = readFileSync(configPath, "utf-8");
  const desired = parseConfig(raw);
  if (desired.warnings?.length) {
    for (const w of desired.warnings) console.log(`\u26A0 ${w}`);
  }
  const configHash = createHash("sha256").update(raw).digest("hex").slice(0, 12);

  const token = await resolveDiscordToken(gwOpts);
  const discord = new DiscordProvider(token, desired.guild);
  await discord.login();

  try {
    const discordState = await discord.fetch();

    let openclawState: OpenClawState = { bindings: [] };
    let ocProvider: OpenClawProvider | null = null;
    const resolved = gwOpts ? await resolveOpenClawProvider(gwOpts) : null;
    if (resolved) {
      ocProvider = resolved.provider;
      if (!json) console.log(`OpenClaw: ${resolved.mode === "api" ? "gateway API" : "CLI"}`);
      openclawState = await ocProvider.fetch();
    } else {
      if (!json) console.log("⚠ OpenClaw not available — bindings will be skipped");
    }

    const { actions } = reconcile(desired, discordState, openclawState, { prune });
    const filteredActions = filterActions(actions, filter);

    if (json && !yes) {
      console.log(JSON.stringify(toDiffJson({
        actions: filteredActions, unmanaged: [], unboundAgents: [], staleAgents: [],
        pins: [], channels: [],
      }), null, 2));
      return filteredActions.some((a) => a.type !== "noop") ? 2 : 0;
    }

    if (!json) {
      console.log(formatActions(filteredActions));
      const summary = filterSummary(filteredActions.length, actions.length, filter);
      if (summary) console.log(summary);
    }

    const changes = filteredActions.filter((a) => a.type !== "noop");
    const bindingActions = filteredActions.filter((a) => a.resourceType === "binding");

    if (changes.length === 0) {
      // No mutations, but routing gates may still need syncing
      if (yes && bindingActions.length > 0 && ocProvider) {
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
        await ocProvider.apply(bindingActions, { guildId: desired.guild });
        if (!json) console.log("✓ Routing gates synced.");
      } else {
        if (!json) console.log("No changes to apply.");
      }
      return 0;
    }

    if (!yes) {
      if (!json) console.log("Dry-run mode. Use --yes to apply changes.");
      return 0;
    }

    // Snapshot before mutation
    const snapshot = {
      timestamp: new Date().toISOString(),
      configHash,
      discord: discordState,
      openclaw: openclawState,
    };
    const snapshotPath = await saveSnapshot(snapshot, snapshotDir);
    console.log(`Snapshot saved: ${snapshotPath}`);

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
          console.log(`⚠ DELETING ${deleteActions.length} resource(s) — THIS IS PERMANENT`);
        }
        await discord.apply(deleteActions);
        appliedCount += deleteActions.length;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n⚠ Apply failed after ${appliedCount}/${discordActions.length} Discord changes.`);
      console.error(`  Error: ${msg}`);
      console.error(`  Snapshot saved: ${snapshotPath}`);
      console.error(`  Rollback: disclaw rollback --yes`);
      return 1;
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
        await ocProvider.apply(bindingActions, { guildId: desired.guild });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\n⚠ OpenClaw apply failed. Discord changes were applied successfully.`);
        console.error(`  Error: ${msg}`);
        console.error(`  Snapshot saved: ${snapshotPath}`);
        console.error(`  Rollback: disclaw rollback --yes`);
        return 1;
      }
    }

    // Verify
    if (!json) console.log("Verifying...");
    const verified = await discord.verify(discordState);
    if (!verified) {
      console.error("⚠ Discord verification failed. Rollback available.");
      console.error(`  Run: disclaw rollback --yes`);
      return 1;
    }
    if (ocProvider) {
      const ocVerified = await ocProvider.verify(openclawState);
      if (!ocVerified) {
        console.error("⚠ OpenClaw verification failed. Rollback available.");
        console.error(`  Run: disclaw rollback --yes`);
        return 1;
      }
    }

    if (json) {
      const entries = filteredActions.map((a) => ({
        op: a.type, type: a.resourceType, name: a.name,
        status: a.type === "noop" ? "skipped" : "applied",
      }));
      console.log(JSON.stringify(entries, null, 2));
    } else {
      console.log("✓ Apply complete. All changes verified.");
      if (deleteActions.length > 0) {
        console.log("  Note: deleted channels cannot be fully restored via rollback.");
      }
      console.log(`  Rollback available: disclaw rollback --yes`);
    }
    return 0;
  } finally {
    await discord.destroy();
  }
}
