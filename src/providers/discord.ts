import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  type Guild,
  type CategoryChannel,
  type TextChannel,
} from "discord.js";
import type {
  Action,
  ActualCategory,
  ActualChannel,
  ActualPin,
  ActualThread,
  DiscordState,
  StateProvider,
} from "../types.ts";

const MANAGED_TAG = "[managed:disclaw]";

export class DiscordProvider implements StateProvider<DiscordState> {
  private client: Client;
  private guildId: string;
  private guild: Guild | null = null;

  private token: string;

  constructor(token: string, guildId: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: { timeout: 30_000 },
    });
    this.token = token;
    this.guildId = guildId;
  }

  async login(): Promise<void> {
    await this.client.login(this.token);
    try {
      this.guild = await this.client.guilds.fetch(this.guildId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unknown Guild") || msg.includes("Missing Access")) {
        throw new Error(
          `Guild "${this.guildId}" not found. Verify the guild: field in your config and that the bot is a member.`,
        );
      }
      throw err;
    }
  }

  async destroy(): Promise<void> {
    this.client.destroy();
  }

  private getGuild(): Guild {
    if (!this.guild) throw new Error("Not logged in — call login() first");
    return this.guild;
  }

  async fetch(): Promise<DiscordState> {
    const guild = this.getGuild();
    const allChannels = await guild.channels.fetch();

    // Collect all categories
    const categories: ActualCategory[] = [];
    for (const [, ch] of allChannels) {
      if (ch && ch.type === ChannelType.GuildCategory) {
        categories.push({
          id: ch.id,
          name: ch.name,
        });
      }
    }

    // Collect all text channels with categoryId tagging
    const textChannels: ActualChannel[] = [];
    const threads: ActualThread[] = [];
    const pins: ActualPin[] = [];

    for (const [, ch] of allChannels) {
      if (ch && ch.type === ChannelType.GuildText) {
        const textCh = ch as TextChannel;

        // Detect private: @everyone denied ViewChannel
        const everyoneOverwrite = textCh.permissionOverwrites.cache.find(
          (ow) => ow.id === textCh.guild.id && ow.type === OverwriteType.Role,
        );
        const isPrivate = everyoneOverwrite?.deny.has(PermissionFlagsBits.ViewChannel) || false;

        // Detect addBot: bot user allowed ViewChannel
        const botUserId = this.client.user?.id;
        const botOverwrite = botUserId
          ? textCh.permissionOverwrites.cache.find(
              (ow) => ow.id === botUserId && ow.type === OverwriteType.Member,
            )
          : undefined;
        const hasAddBot = botOverwrite?.allow.has(PermissionFlagsBits.ViewChannel) || false;

        textChannels.push({
          id: textCh.id,
          name: textCh.name,
          type: "text",
          topic: textCh.topic ?? undefined,
          restricted: textCh.nsfw || undefined,
          private: isPrivate || undefined,
          addBot: hasAddBot || undefined,
          categoryId: textCh.parentId ?? undefined,
        });

        const activeThreads = await textCh.threads.fetchActive();
        for (const [, thread] of activeThreads.threads) {
          threads.push({
            id: thread.id,
            name: thread.name,
            parentChannelId: textCh.id,
          });
        }

        // Fetch pins for read-only display
        const pinnedMessages = await textCh.messages.fetchPins();
        for (const pin of pinnedMessages.items) {
          pins.push({
            messageId: pin.message.id,
            channelId: textCh.id,
            content: pin.message.content,
          });
        }
      }
    }

    return {
      categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
      channels: textChannels.sort((a, b) => a.name.localeCompare(b.name)),
      threads: threads.sort((a, b) => a.name.localeCompare(b.name)),
      pins,
    };
  }

  private buildPermissionOverwrites(
    isPrivate?: boolean,
    addBot?: boolean,
  ): { id: string; deny?: bigint[]; allow?: bigint[]; type: OverwriteType }[] {
    const overwrites: { id: string; deny?: bigint[]; allow?: bigint[]; type: OverwriteType }[] = [];

    if (isPrivate) {
      const guild = this.getGuild();
      overwrites.push({
        id: guild.id, // @everyone role ID === guild ID
        deny: [PermissionFlagsBits.ViewChannel],
        type: OverwriteType.Role,
      });
    }

    if (addBot && this.client.user) {
      overwrites.push({
        id: this.client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        type: OverwriteType.Member,
      });
    }

    return overwrites;
  }

  async apply(actions: Action[]): Promise<void> {
    const guild = this.getGuild();
    const channelMap = new Map<string, string>();
    const categoryMap = new Map<string, string>();

    const existingChannels = await guild.channels.fetch();
    for (const [, ch] of existingChannels) {
      if (!ch) continue;
      if (ch.type === ChannelType.GuildText) {
        channelMap.set(ch.name, ch.id);
      }
      if (ch.type === ChannelType.GuildCategory) {
        categoryMap.set(ch.name, ch.id);
      }
    }

    try {
      for (const action of actions) {
        if (action.type === "noop") continue;

        switch (action.resourceType) {
          case "category": {
            if (action.type === "create") {
              const created = await guild.channels.create({
                name: action.name,
                type: ChannelType.GuildCategory,
              });
              categoryMap.set(action.name, created.id);
            } else if (action.type === "delete") {
              const catId = (action.details?.before as Record<string, string>)?.id
                ?? categoryMap.get(action.name);
              if (catId) {
                const cat = await guild.channels.fetch(catId);
                if (cat) await cat.delete();
                categoryMap.delete(action.name);
              }
            }
            break;
          }
          case "channel": {
            if (action.type === "create") {
              const after = action.details?.after as Record<string, unknown> | undefined;
              const topic = after?.topic as string | undefined;
              const categoryName = after?.categoryName as string | undefined;
              const restricted = after?.restricted as boolean | undefined;
              const isPrivate = after?.private as boolean | undefined;
              const addBot = after?.addBot as boolean | undefined;
              const parentId = categoryName ? categoryMap.get(categoryName) : undefined;
              const permissionOverwrites = this.buildPermissionOverwrites(isPrivate, addBot);
              const created = await guild.channels.create({
                name: action.name,
                type: ChannelType.GuildText,
                parent: parentId,
                topic: topic || undefined,
                nsfw: restricted || undefined,
                permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined,
              });
              channelMap.set(action.name, created.id);
            } else if (action.type === "update") {
              const chId = channelMap.get(action.name);
              if (chId) {
                const ch = (await guild.channels.fetch(chId)) as TextChannel;
                const after = action.details?.after as Record<string, unknown> | undefined;
                const topic = after?.topic as string | undefined;
                const categoryName = after?.categoryName as string | undefined;
                const restricted = after?.restricted as boolean | undefined;
                const isPrivate = after?.private as boolean | undefined;
                const addBot = after?.addBot as boolean | undefined;
                const parentId = categoryName ? categoryMap.get(categoryName) : undefined;
                const parentChanged = "categoryName" in (after ?? {});
                const privateChanged = "private" in (after ?? {});
                const addBotChanged = "addBot" in (after ?? {});

                await ch.edit({
                  topic: topic || undefined,
                  nsfw: restricted ?? false,
                  ...(parentChanged ? { parent: parentId ?? null } : {}),
                });

                // Sync permission overwrites if private or addBot changed
                if (privateChanged || addBotChanged) {
                  const permissionOverwrites = this.buildPermissionOverwrites(isPrivate, addBot);
                  await ch.permissionOverwrites.set(permissionOverwrites);
                }
              }
            } else if (action.type === "delete") {
              const chId = (action.details?.before as Record<string, string>)?.id
                ?? channelMap.get(action.name);
              if (chId) {
                const ch = await guild.channels.fetch(chId);
                if (ch) await ch.delete();
                channelMap.delete(action.name);
              }
            }
            break;
          }
          case "thread": {
            if (action.type === "create") {
              const parentName = (
                action.details?.after as Record<string, string>
              )?.parentChannel;
              const parentId = parentName
                ? channelMap.get(parentName)
                : undefined;
              if (parentId) {
                const parent = (await guild.channels.fetch(
                  parentId,
                )) as TextChannel;
                await parent.threads.create({ name: action.name });
              }
            } else if (action.type === "delete") {
              const thId = (action.details?.before as Record<string, string>)?.id;
              if (thId) {
                const th = await guild.channels.fetch(thId);
                if (th) await th.delete();
              }
            }
            break;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Missing Permissions") || msg.includes("Missing Access")) {
        throw new Error(
          "Bot lacks permission to manage channels in this guild. Check the bot role has \"Manage Channels\" permission.",
        );
      }
      throw err;
    }
  }

  async verify(expected: DiscordState): Promise<boolean> {
    const actual = await this.fetch();
    for (const expCat of expected.categories) {
      if (!actual.categories.some((a) => a.name === expCat.name)) return false;
    }
    for (const expCh of expected.channels) {
      if (!actual.channels.some((a) => a.name === expCh.name)) return false;
    }
    return true;
  }

  async getChannelIdByName(name: string): Promise<string | undefined> {
    const guild = this.getGuild();
    const channels = await guild.channels.fetch();
    for (const [, ch] of channels) {
      if (ch && ch.name === name) return ch.id;
    }
    return undefined;
  }
}
