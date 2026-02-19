import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type {
  DesiredState,
  FlatDesiredBinding,
  FlatDesiredChannel,
  FlatDesiredState,
  FlatDesiredThread,
} from "./types.ts";
import { isCategoryGroup, isAgentBindingObject } from "./types.ts";

// -- Zod schemas --

const ChannelSchema = z.object({
  name: z.string(),
  topic: z.string().optional(),
  restricted: z.boolean().optional(),
  threads: z.array(z.string()).optional(),
});

const CategoryGroupSchema = z.object({
  category: z.string(),
  channels: z.array(ChannelSchema),
});

const ChannelEntrySchema = z.union([ChannelSchema, CategoryGroupSchema]);

const AgentBindingItemSchema = z.object({
  channel: z.string(),
  requireMention: z.boolean().optional(),
});

const AgentBindingObjectSchema = z.object({
  channel: z.union([z.string(), z.array(z.string())]),
  requireMention: z.boolean().optional(),
});

const AgentChannelsSchema = z.union([
  z.string(),
  z.array(z.union([z.string(), AgentBindingItemSchema])),
  AgentBindingObjectSchema,
]);

const OpenClawSchema = z.object({
  requireMention: z.boolean().optional(),
  agents: z.record(z.string(), AgentChannelsSchema),
});

const DesiredStateSchema = z.object({
  version: z.literal(1),
  managedBy: z.literal("disclaw"),
  guild: z.string(),
  channels: z.array(ChannelEntrySchema),
  openclaw: OpenClawSchema.optional(),
});

// -- Validation --

function validateDesiredState(state: DesiredState): string[] {
  const warnings: string[] = [];
  const channelNames = new Set<string>();
  const categoryNames = new Set<string>();

  for (const entry of state.channels) {
    if (isCategoryGroup(entry)) {
      if (!entry.category.trim()) {
        throw new Error("Empty name not allowed for category");
      }
      if (categoryNames.has(entry.category)) {
        throw new Error(`Duplicate category name: "${entry.category}"`);
      }
      categoryNames.add(entry.category);
      if (entry.channels.length === 0) {
        warnings.push(`Category "${entry.category}" has no channels`);
      }
      for (const ch of entry.channels) {
        if (!ch.name.trim()) {
          throw new Error("Empty name not allowed for channel");
        }
        if (channelNames.has(ch.name)) {
          throw new Error(`Duplicate channel name: "${ch.name}"`);
        }
        channelNames.add(ch.name);
        if (ch.threads) {
          const seenThreads = new Set<string>();
          for (const t of ch.threads) {
            if (!t.trim()) {
              throw new Error(`Empty name not allowed for thread in channel "${ch.name}"`);
            }
            if (seenThreads.has(t)) {
              throw new Error(`Duplicate thread "${t}" under channel "${ch.name}"`);
            }
            seenThreads.add(t);
          }
        }
      }
    } else {
      if (!entry.name.trim()) {
        throw new Error("Empty name not allowed for channel");
      }
      if (channelNames.has(entry.name)) {
        throw new Error(`Duplicate channel name: "${entry.name}"`);
      }
      channelNames.add(entry.name);
      if (entry.threads) {
        const seenThreads = new Set<string>();
        for (const t of entry.threads) {
          if (!t.trim()) {
            throw new Error(`Empty name not allowed for thread in channel "${entry.name}"`);
          }
          if (seenThreads.has(t)) {
            throw new Error(`Duplicate thread "${t}" under channel "${entry.name}"`);
          }
          seenThreads.add(t);
        }
      }
    }
  }

  // Validate binding channel refs exist in channels[] and check for duplicates
  if (state.openclaw) {
    const seenBindings = new Set<string>();

    for (const [agentName, value] of Object.entries(state.openclaw.agents)) {
      const channelRefs: string[] = [];

      if (isAgentBindingObject(value)) {
        const refs = Array.isArray(value.channel) ? value.channel : [value.channel];
        channelRefs.push(...refs);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          channelRefs.push(typeof item === "string" ? item : item.channel);
        }
      } else {
        channelRefs.push(value);
      }

      for (const ref of channelRefs) {
        if (!channelNames.has(ref)) {
          throw new Error(
            `Agent "${agentName}" binds to "${ref}" but no channel "${ref}" is defined in channels[]`,
          );
        }
        const bindingKey = `${agentName}:${ref}`;
        if (seenBindings.has(bindingKey)) {
          throw new Error(
            `Duplicate binding: agent "${agentName}" → channel "${ref}" (defined twice)`,
          );
        }
        seenBindings.add(bindingKey);
      }
    }
  }

  return warnings;
}

// -- Public API --

export function parseConfig(raw: string): DesiredState {
  const parsed = parseYaml(raw);
  const state = DesiredStateSchema.parse(parsed) as DesiredState;
  const warnings = validateDesiredState(state);
  if (warnings.length > 0) {
    state.warnings = warnings;
  }
  return state;
}

export function flattenDesiredState(state: DesiredState): FlatDesiredState {
  const categories: string[] = [];
  const channels: FlatDesiredChannel[] = [];
  const threads: FlatDesiredThread[] = [];
  const bindings: FlatDesiredBinding[] = [];

  for (const entry of state.channels) {
    if (isCategoryGroup(entry)) {
      categories.push(entry.category);
      for (const ch of entry.channels) {
        channels.push({
          name: ch.name,
          topic: ch.topic,
          restricted: ch.restricted,
          categoryName: entry.category,
        });
        if (ch.threads) {
          for (const t of ch.threads) {
            threads.push({ parentChannel: ch.name, name: t });
          }
        }
      }
    } else {
      channels.push({ name: entry.name, topic: entry.topic, restricted: entry.restricted });
      if (entry.threads) {
        for (const t of entry.threads) {
          threads.push({ parentChannel: entry.name, name: t });
        }
      }
    }
  }

  if (state.openclaw) {
    const guildDefault = state.openclaw.requireMention;

    for (const [agentName, value] of Object.entries(state.openclaw.agents)) {
      if (isAgentBindingObject(value)) {
        // Object form: { channel: string | string[], requireMention?: boolean }
        const channelRefs = Array.isArray(value.channel) ? value.channel : [value.channel];
        const requireMention = value.requireMention ?? guildDefault;
        for (const channelRef of channelRefs) {
          bindings.push({ agentName, channelRef, requireMention });
        }
      } else if (Array.isArray(value)) {
        // Mixed array: (string | { channel, requireMention })[]
        for (const item of value) {
          if (typeof item === "string") {
            bindings.push({ agentName, channelRef: item, requireMention: guildDefault });
          } else {
            bindings.push({
              agentName,
              channelRef: item.channel,
              requireMention: item.requireMention ?? guildDefault,
            });
          }
        }
      } else {
        // String shorthand
        bindings.push({ agentName, channelRef: value, requireMention: guildDefault });
      }
    }
  }

  return { categories, channels, threads, bindings };
}
