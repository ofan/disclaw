import type {
  Action,
  DesiredState,
  DiscordState,
  OpenClawState,
  ReconcileResult,
  UnmanagedResource,
} from "./types.ts";
import { flattenDesiredState } from "./parser.ts";

export interface ReconcileOptions {
  prune?: boolean;
}

export function reconcile(
  desired: DesiredState,
  discord: DiscordState,
  openclaw: OpenClawState,
  options: ReconcileOptions = {},
): ReconcileResult {
  const actions: Action[] = [];
  const unmanaged: UnmanagedResource[] = [];
  const flat = flattenDesiredState(desired);

  // 1. Categories (sorted by name for determinism)
  const desiredCategoryNames = new Set(flat.categories);

  for (const catName of [...flat.categories].sort()) {
    const existing = discord.categories.find((c) => c.name === catName);
    if (!existing) {
      actions.push({
        type: "create",
        resourceType: "category",
        name: catName,
        details: { after: { name: catName } },
      });
    } else {
      actions.push({ type: "noop", resourceType: "category", name: catName });
    }
  }

  // Detect unmanaged categories
  for (const cat of discord.categories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!desiredCategoryNames.has(cat.name)) {
      if (options.prune) {
        actions.push({
          type: "delete",
          resourceType: "category",
          name: cat.name,
          details: { before: { id: cat.id } },
        });
      } else {
        unmanaged.push({
          resourceType: "category",
          name: cat.name,
          id: cat.id,
        });
      }
    }
  }

  // 2. Channels (sorted by name for determinism)
  const desiredChannelNames = new Set(flat.channels.map((c) => c.name));

  for (const ch of [...flat.channels].sort((a, b) => a.name.localeCompare(b.name))) {
    const existing = discord.channels.find((c) => c.name === ch.name);
    if (!existing) {
      actions.push({
        type: "create",
        resourceType: "channel",
        name: ch.name,
        details: {
          after: {
            topic: ch.topic,
            ...(ch.restricted ? { restricted: true } : {}),
            ...(ch.private ? { private: true } : {}),
            ...(ch.addBot ? { addBot: true } : {}),
            ...(ch.categoryName ? { categoryName: ch.categoryName } : {}),
          },
        },
      });
    } else {
      // Check for topic change, category change, or restricted change
      const existingCat = existing.categoryId
        ? discord.categories.find((c) => c.id === existing.categoryId)
        : undefined;
      const topicChanged = existing.topic !== ch.topic;
      const categoryChanged = (existingCat?.name ?? undefined) !== ch.categoryName;
      const restrictedChanged = !!existing.restricted !== !!ch.restricted;
      const privateChanged = !!existing.private !== !!ch.private;
      const addBotChanged = !!existing.addBot !== !!ch.addBot;

      if (topicChanged || categoryChanged || restrictedChanged || privateChanged || addBotChanged) {
        actions.push({
          type: "update",
          resourceType: "channel",
          name: ch.name,
          details: {
            before: {
              topic: existing.topic,
              ...(existing.restricted ? { restricted: true } : {}),
              ...(existing.private ? { private: true } : {}),
              ...(existing.addBot ? { addBot: true } : {}),
              ...(existingCat ? { categoryName: existingCat.name } : {}),
            },
            after: {
              topic: ch.topic,
              ...(ch.restricted ? { restricted: true } : {}),
              ...(ch.private ? { private: true } : {}),
              ...(ch.addBot ? { addBot: true } : {}),
              ...(ch.categoryName
                ? { categoryName: ch.categoryName }
                : categoryChanged
                  ? { categoryName: null }
                  : {}),
            },
          },
        });
      } else {
        actions.push({ type: "noop", resourceType: "channel", name: ch.name });
      }
    }
  }

  // Detect unmanaged channels
  for (const ch of discord.channels.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!desiredChannelNames.has(ch.name)) {
      if (options.prune) {
        actions.push({
          type: "delete",
          resourceType: "channel",
          name: ch.name,
          details: { before: { id: ch.id, topic: ch.topic } },
        });
      } else {
        unmanaged.push({
          resourceType: "channel",
          name: ch.name,
          id: ch.id,
          topic: ch.topic,
        });
      }
    }
  }

  // 3. Threads (sorted by parentChannel+name)
  const desiredThreadKeys = new Set(
    flat.threads.map((t) => `${t.parentChannel}:${t.name}`),
  );

  for (const th of [...flat.threads].sort((a, b) =>
    `${a.parentChannel}:${a.name}`.localeCompare(`${b.parentChannel}:${b.name}`),
  )) {
    const parentChannel = discord.channels.find((c) => c.name === th.parentChannel);
    const existing = discord.threads.find(
      (t) => t.name === th.name && (parentChannel ? t.parentChannelId === parentChannel.id : false),
    );
    if (!existing) {
      actions.push({
        type: "create",
        resourceType: "thread",
        name: th.name,
        details: { after: { parentChannel: th.parentChannel } },
      });
    } else {
      actions.push({ type: "noop", resourceType: "thread", name: th.name });
    }
  }

  // Detect unmanaged threads
  for (const th of discord.threads.sort((a, b) => a.name.localeCompare(b.name))) {
    const parentChannel = discord.channels.find((c) => c.id === th.parentChannelId);
    const key = parentChannel ? `${parentChannel.name}:${th.name}` : `:${th.name}`;
    if (!desiredThreadKeys.has(key)) {
      if (options.prune) {
        actions.push({
          type: "delete",
          resourceType: "thread",
          name: th.name,
          details: { before: { id: th.id, parentChannelId: th.parentChannelId } },
        });
      } else {
        unmanaged.push({
          resourceType: "thread",
          name: th.name,
          id: th.id,
        });
      }
    }
  }

  // 4. OpenClaw bindings (sorted by agentName)
  for (const binding of [...flat.bindings].sort((a, b) =>
    a.agentName.localeCompare(b.agentName),
  )) {
    const resolvedChannel = discord.channels.find((c) => c.name === binding.channelRef);
    const existing = openclaw.bindings.find(
      (b) =>
        b.agentId === binding.agentName &&
        (resolvedChannel ? b.match.peer.id === resolvedChannel.id : false),
    );
    if (!existing) {
      actions.push({
        type: "create",
        resourceType: "binding",
        name: `${binding.agentName} → ${binding.channelRef}`,
        details: {
          after: {
            agentName: binding.agentName,
            channelRef: binding.channelRef,
            ...(binding.requireMention !== undefined ? { requireMention: binding.requireMention } : {}),
          },
        },
      });
    } else {
      actions.push({
        type: "noop",
        resourceType: "binding",
        name: `${binding.agentName} → ${binding.channelRef}`,
        details: {
          after: {
            agentName: binding.agentName,
            channelRef: binding.channelRef,
            ...(binding.requireMention !== undefined ? { requireMention: binding.requireMention } : {}),
          },
        },
      });
    }
  }

  // Detect stale bindings (in OpenClaw but not in config) — always emit delete
  const desiredBindingKeys = new Set(
    flat.bindings.map((b) => {
      const ch = discord.channels.find((c) => c.name === b.channelRef);
      return ch ? `${b.agentName}:${ch.id}` : null;
    }).filter(Boolean),
  );

  for (const binding of [...openclaw.bindings]
    .filter((b) => b.match.channel === "discord")
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
  ) {
    const key = `${binding.agentId}:${binding.match.peer.id}`;
    if (!desiredBindingKeys.has(key)) {
      const ch = discord.channels.find((c) => c.id === binding.match.peer.id);
      const channelName = ch?.name ?? binding.match.peer.id;
      actions.push({
        type: "delete",
        resourceType: "binding",
        name: `${binding.agentId} → ${channelName}`,
        details: {
          before: {
            agentName: binding.agentId,
            channelRef: channelName,
            resolvedChannelId: binding.match.peer.id,
          },
        },
      });
    }
  }

  return { actions, unmanaged };
}
