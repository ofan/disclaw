import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { Action, ActualBinding, ApplyContext, OpenClawState, StateProvider } from "../types.ts";

// Zod schema for validating OpenClaw CLI responses (detects API drift)
const BindingResponseSchema = z.array(
  z.object({
    agentId: z.string(),
    match: z.object({
      channel: z.string(),
      peer: z.object({
        kind: z.string(),
        id: z.string(),
      }),
    }),
  }),
);

const AgentsListResponseSchema = z.array(
  z.object({
    id: z.string(),
  }),
);

// Routing config: channels.discord.guilds.<guildId>
const ChannelAllowlistEntrySchema = z.object({
  allow: z.boolean().optional(),
  requireMention: z.boolean().optional(),
}).passthrough();

const GuildRoutingConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  channels: z.record(z.string(), ChannelAllowlistEntrySchema).optional(),
}).passthrough();

export type GuildRoutingConfig = z.infer<typeof GuildRoutingConfigSchema>;
export type ChannelAllowlistEntry = z.infer<typeof ChannelAllowlistEntrySchema>;

// -- Gateway HTTP API response parsing --

// /tools/invoke returns { ok, result: { content: [{ type, text }] } }
export function parseToolsInvokeResponse(response: unknown): unknown {
  const resp = response as Record<string, unknown>;
  if (!resp.ok) {
    const error = resp.error as Record<string, string> | undefined;
    throw new Error(`Gateway API error: ${error?.message ?? "unknown error"}`);
  }
  const result = resp.result as Record<string, unknown> | undefined;
  const content = result?.content as Array<{ type: string; text: string }> | undefined;
  if (!content || content.length === 0) {
    throw new Error("Gateway API returned empty content");
  }
  return JSON.parse(content[0].text);
}

// config.get returns { exists, hash, raw (JSON string of full config) }
export interface ParsedConfig {
  hash: string;
  bindings: ActualBinding[];
  discordToken?: string;
  fullConfig: Record<string, unknown>;
  getGuildRouting(guildId: string): GuildRoutingConfig;
}

export function parseConfigGetResponse(result: unknown): ParsedConfig {
  const r = result as Record<string, unknown>;
  const hash = r.hash as string;
  const raw = typeof r.raw === "string" ? JSON.parse(r.raw) : r.raw;
  const fullConfig = raw as Record<string, unknown>;

  // Extract bindings
  const rawBindings = fullConfig.bindings;
  let bindings: ActualBinding[] = [];
  if (Array.isArray(rawBindings)) {
    bindings = BindingResponseSchema.parse(rawBindings);
  }

  // Extract Discord token
  const channels = fullConfig.channels as Record<string, unknown> | undefined;
  const discord = channels?.discord as Record<string, unknown> | undefined;
  const discordToken = discord?.token as string | undefined;

  return {
    hash,
    bindings,
    discordToken,
    fullConfig,
    getGuildRouting(guildId: string): GuildRoutingConfig {
      const guilds = discord?.guilds as Record<string, unknown> | undefined;
      const guild = guilds?.[guildId] as Record<string, unknown> | undefined;
      if (!guild) return { channels: {} };
      return GuildRoutingConfigSchema.parse(guild);
    },
  };
}

// -- Agents list response schema (from /tools/invoke agents_list) --
const AgentsListAPIResponseSchema = z.object({
  agents: z.array(z.object({ id: z.string() })),
}).passthrough();

export class OpenClawAPIProvider implements StateProvider<OpenClawState> {
  private gatewayUrl: string;
  private gatewayToken: string;
  private cachedConfig: ParsedConfig | null = null;

  constructor(opts: { gatewayUrl: string; gatewayToken: string }) {
    this.gatewayUrl = opts.gatewayUrl;
    this.gatewayToken = opts.gatewayToken;
  }

  private async invokeGatewayTool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(`${this.gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.gatewayToken}`,
      },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      throw new Error("Gateway auth failed. Check OPENCLAW_GATEWAY_TOKEN or --gateway-token.");
    }
    if (response.status === 404) {
      throw new Error(
        `Gateway tool "${tool}" not available. Ensure gateway.tools.allow includes "gateway" in openclaw.json.`,
      );
    }
    if (!response.ok) {
      throw new Error(`Gateway HTTP error ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  private async getConfig(): Promise<ParsedConfig> {
    if (this.cachedConfig) return this.cachedConfig;
    const response = await this.invokeGatewayTool("gateway", { action: "config.get" });
    const toolResult = parseToolsInvokeResponse(response);
    this.cachedConfig = parseConfigGetResponse(toolResult);
    return this.cachedConfig;
  }

  private invalidateCache(): void {
    this.cachedConfig = null;
  }

  async fetch(): Promise<OpenClawState> {
    const config = await this.getConfig();
    return { bindings: config.bindings };
  }

  async fetchAgents(): Promise<string[]> {
    const response = await this.invokeGatewayTool("agents_list", {});
    const data = parseToolsInvokeResponse(response);
    const parsed = AgentsListAPIResponseSchema.parse(data);
    return parsed.agents.map((a) => a.id);
  }

  async fetchRoutingConfig(guildId: string): Promise<GuildRoutingConfig> {
    const config = await this.getConfig();
    return config.getGuildRouting(guildId);
  }

  async resolveDiscordToken(): Promise<string> {
    if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
    const config = await this.getConfig();
    if (config.discordToken) return config.discordToken;
    throw new Error(
      "Discord bot token not found. Set DISCORD_BOT_TOKEN env var or ensure channels.discord.token is in OpenClaw config.",
    );
  }

  async apply(actions: Action[], context?: ApplyContext): Promise<void> {
    const allBindingActions = actions.filter((a) => a.resourceType === "binding");
    const bindingMutations = allBindingActions.filter((a) => a.type !== "noop");

    let updatedBindings: ActualBinding[] | undefined;
    if (bindingMutations.length > 0) {
      const config = await this.getConfig();
      const updated = [...config.bindings];

      for (const action of bindingMutations) {
        if (action.type === "create" && action.details?.after) {
          const { agentName } = action.details.after as { agentName: string };
          const channelId = (action.details.after as Record<string, string>).resolvedChannelId;
          if (channelId) {
            updated.push({
              agentId: agentName,
              match: { channel: "discord", peer: { kind: "channel", id: channelId } },
            });
          }
        }
        if (action.type === "delete" && action.details?.before) {
          const { agentName } = action.details.before as { agentName: string };
          const channelId = (action.details.before as Record<string, string>).resolvedChannelId;
          const idx = updated.findIndex(
            (b) => b.agentId === agentName && (!channelId || b.match.peer.id === channelId),
          );
          if (idx !== -1) updated.splice(idx, 1);
        }
      }

      await this.patchConfig({ bindings: updated });
      updatedBindings = updated;
    }

    if (context?.guildId && allBindingActions.length > 0) {
      await this.syncRoutingGates(context.guildId, allBindingActions, updatedBindings);
    }
  }

  private async syncRoutingGates(
    guildId: string,
    allBindingActions: Action[],
    updatedBindings?: ActualBinding[],
  ): Promise<void> {
    const routingConfig = await this.fetchRoutingConfig(guildId);
    const channels: Record<string, ChannelAllowlistEntry> = { ...routingConfig.channels };

    const boundChannelIds = updatedBindings
      ? new Set(updatedBindings.filter((b) => b.match.channel === "discord").map((b) => b.match.peer.id))
      : undefined;

    for (const action of allBindingActions) {
      const details = action.details?.after as Record<string, unknown> | undefined;
      if (!details) continue;
      const channelId = details.resolvedChannelId as string | undefined;
      if (!channelId) continue;
      const requireMention = details.requireMention as boolean | undefined;

      if (action.type === "create" || action.type === "noop") {
        const existing = channels[channelId] ?? {};
        channels[channelId] = {
          ...existing,
          allow: true,
          ...(requireMention !== undefined ? { requireMention } : {}),
        };
      }

      if (action.type === "delete") {
        const deleteChannelId = (action.details?.before as Record<string, unknown> | undefined)
          ?.resolvedChannelId as string | undefined;
        if (!deleteChannelId) continue;
        if (boundChannelIds && !boundChannelIds.has(deleteChannelId)) {
          const existing = channels[deleteChannelId];
          if (existing) {
            channels[deleteChannelId] = { ...existing, allow: false };
          }
        }
      }
    }

    await this.patchConfig({
      channels: { discord: { guilds: { [guildId]: { channels } } } },
    });
  }

  private async patchConfig(patch: Record<string, unknown>): Promise<void> {
    const config = await this.getConfig();
    await this.invokeGatewayTool("gateway", {
      action: "config.patch",
      raw: JSON.stringify(patch),
      baseHash: config.hash,
    });
    this.invalidateCache();
  }

  async verify(expected: OpenClawState): Promise<boolean> {
    this.invalidateCache();
    const actual = await this.fetch();
    for (const exp of expected.bindings) {
      const found = actual.bindings.some(
        (a) =>
          a.agentId === exp.agentId &&
          a.match.channel === exp.match.channel &&
          a.match.peer.id === exp.match.peer.id,
      );
      if (!found) return false;
    }
    return true;
  }
}

// -- Gateway probe + provider factory --

export async function probeGatewayAPI(opts: { gatewayUrl: string; gatewayToken: string }): Promise<boolean> {
  if (!opts.gatewayToken) return false;
  try {
    const response = await fetch(`${opts.gatewayUrl}/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.gatewayToken}`,
      },
      body: JSON.stringify({ tool: "gateway", args: { action: "config.get" } }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export type OpenClawProvider = OpenClawAPIProvider | OpenClawCLIProvider;

export async function resolveOpenClawProvider(
  gwOpts: { gatewayUrl: string; gatewayToken: string },
): Promise<{ provider: OpenClawProvider; mode: "api" | "cli" } | null> {
  // Try API first
  if (await probeGatewayAPI(gwOpts)) {
    return { provider: new OpenClawAPIProvider(gwOpts), mode: "api" };
  }

  // Fall back to CLI
  if (await probeOpenClawCLI()) {
    return { provider: new OpenClawCLIProvider(), mode: "cli" };
  }

  return null;
}

export function parseBindingsResponse(raw: string): ActualBinding[] {
  try {
    const parsed = JSON.parse(raw);
    return BindingResponseSchema.parse(parsed);
  } catch {
    throw new Error(
      `OpenClaw CLI returned unexpected data. This usually means the API changed.\nRaw: ${raw.slice(0, 200)}`,
    );
  }
}

export function parseAgentsResponse(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    const agents = AgentsListResponseSchema.parse(parsed);
    return agents.map((a) => a.id);
  } catch {
    throw new Error(
      `OpenClaw CLI returned unexpected data. This usually means the API changed.\nRaw: ${raw.slice(0, 200)}`,
    );
  }
}

export function parseRoutingConfigResponse(raw: string): GuildRoutingConfig {
  try {
    const parsed = JSON.parse(raw);
    return GuildRoutingConfigSchema.parse(parsed);
  } catch {
    throw new Error(
      `OpenClaw CLI returned unexpected data. This usually means the API changed.\nRaw: ${raw.slice(0, 200)}`,
    );
  }
}

export async function resolveDiscordToken(
  gwOpts?: { gatewayUrl: string; gatewayToken: string },
): Promise<string> {
  // 1. Env var takes precedence
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;

  // 2. Try gateway API
  if (gwOpts?.gatewayToken) {
    try {
      const provider = new OpenClawAPIProvider(gwOpts);
      return await provider.resolveDiscordToken();
    } catch {
      // fall through to CLI
    }
  }

  // 3. Fall back to CLI
  try {
    const token = execFileSync("openclaw", ["config", "get", "channels.discord.token"], {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (token) return token;
  } catch {
    // fall through
  }

  throw new Error(
    "Discord bot token not found. Set DISCORD_BOT_TOKEN env var or ensure OpenClaw is configured.",
  );
}

export async function probeOpenClawCLI(): Promise<boolean> {
  try {
    execFileSync("openclaw", ["config", "get", "bindings", "--json"], {
      timeout: 10_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function execOpenClaw(args: string[]): string {
  try {
    return execFileSync("openclaw", args, {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch (err: unknown) {
    if (err instanceof Error && "killed" in err && (err as Record<string, unknown>).killed) {
      throw new Error("OpenClaw CLI timed out after 15s. Is the openclaw process responsive?");
    }
    throw err;
  }
}

export class OpenClawCLIProvider implements StateProvider<OpenClawState> {
  async fetch(): Promise<OpenClawState> {
    const raw = execOpenClaw(["config", "get", "bindings", "--json"]);
    const bindings = parseBindingsResponse(raw);
    return { bindings };
  }

  async fetchAgents(): Promise<string[]> {
    const raw = execOpenClaw(["agents", "list", "--json"]);
    return parseAgentsResponse(raw);
  }

  async fetchRoutingConfig(guildId: string): Promise<GuildRoutingConfig> {
    try {
      const raw = execOpenClaw([
        "config", "get", `channels.discord.guilds.${guildId}`, "--json",
      ]);
      return parseRoutingConfigResponse(raw);
    } catch {
      // Guild config may not exist yet
      return { channels: {} };
    }
  }

  async apply(actions: Action[], context?: ApplyContext): Promise<void> {
    const allBindingActions = actions.filter((a) => a.resourceType === "binding");
    const bindingMutations = allBindingActions.filter((a) => a.type !== "noop");

    // Write binding changes (create/delete only)
    let updatedBindings: ActualBinding[] | undefined;
    if (bindingMutations.length > 0) {
      const current = await this.fetch();
      const updated = [...current.bindings];

      for (const action of bindingMutations) {
        if (action.type === "create" && action.details?.after) {
          const { agentName } = action.details.after as { agentName: string };
          const channelId = (action.details.after as Record<string, string>).resolvedChannelId;
          if (channelId) {
            updated.push({
              agentId: agentName,
              match: { channel: "discord", peer: { kind: "channel", id: channelId } },
            });
          }
        }
        if (action.type === "delete" && action.details?.before) {
          const { agentName } = action.details.before as { agentName: string };
          const channelId = (action.details.before as Record<string, string>).resolvedChannelId;
          const idx = updated.findIndex(
            (b) => b.agentId === agentName && (!channelId || b.match.peer.id === channelId),
          );
          if (idx !== -1) updated.splice(idx, 1);
        }
      }

      const json = JSON.stringify(updated);
      execOpenClaw(["config", "set", "bindings", json, "--json"]);
      updatedBindings = updated;
    }

    // Sync routing gates (allowlist + requireMention) for all bindings
    if (context?.guildId && allBindingActions.length > 0) {
      await this.syncRoutingGates(context.guildId, allBindingActions, updatedBindings);
    }
  }

  private async syncRoutingGates(
    guildId: string,
    allBindingActions: Action[],
    updatedBindings?: ActualBinding[],
  ): Promise<void> {
    const routingConfig = await this.fetchRoutingConfig(guildId);
    const channels: Record<string, ChannelAllowlistEntry> = { ...routingConfig.channels };

    // Determine which channel IDs are still bound after mutations
    const boundChannelIds = updatedBindings
      ? new Set(updatedBindings.filter((b) => b.match.channel === "discord").map((b) => b.match.peer.id))
      : undefined;

    for (const action of allBindingActions) {
      const details = action.details?.after as Record<string, unknown> | undefined;
      if (!details) continue;

      const channelId = details.resolvedChannelId as string | undefined;
      if (!channelId) continue;
      const requireMention = details.requireMention as boolean | undefined;

      if (action.type === "create" || action.type === "noop") {
        // Ensure bound channels are allowlisted; sync requireMention
        const existing = channels[channelId] ?? {};
        channels[channelId] = {
          ...existing,
          allow: true,
          ...(requireMention !== undefined ? { requireMention } : {}),
        };
      }

      if (action.type === "delete") {
        const deleteChannelId = (action.details?.before as Record<string, unknown> | undefined)
          ?.resolvedChannelId as string | undefined;
        if (!deleteChannelId) continue;

        // Only disallow if no remaining bindings reference this channel
        if (boundChannelIds && !boundChannelIds.has(deleteChannelId)) {
          const existing = channels[deleteChannelId];
          if (existing) {
            channels[deleteChannelId] = { ...existing, allow: false };
          }
        }
      }
    }

    const channelsJson = JSON.stringify(channels);
    execOpenClaw([
      "config", "set", `channels.discord.guilds.${guildId}.channels`, channelsJson, "--json",
    ]);
  }

  async verify(expected: OpenClawState): Promise<boolean> {
    const actual = await this.fetch();
    for (const exp of expected.bindings) {
      const found = actual.bindings.some(
        (a) =>
          a.agentId === exp.agentId &&
          a.match.channel === exp.match.channel &&
          a.match.peer.id === exp.match.peer.id,
      );
      if (!found) return false;
    }
    return true;
  }
}
