import { join } from "node:path";

// -- Action types --

export type ActionType = "create" | "update" | "delete" | "noop";

export type ResourceType = "category" | "channel" | "thread" | "binding";

export interface Action {
  type: ActionType;
  resourceType: ResourceType;
  name: string;
  details?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

// -- Provider interface (blast shield) --

export interface ApplyContext {
  guildId?: string;
}

export interface StateProvider<TState> {
  fetch(): Promise<TState>;
  apply(actions: Action[], context?: ApplyContext): Promise<void>;
  verify(expected: TState): Promise<boolean>;
}

// -- Desired state (parsed from disclaw.yaml) --

export interface DesiredChannel {
  name: string;
  topic?: string;
  restricted?: boolean;
  threads?: string[];
}

export interface DesiredCategoryGroup {
  category: string;
  channels: DesiredChannel[];
}

export type DesiredChannelEntry = DesiredChannel | DesiredCategoryGroup;

export function isCategoryGroup(
  entry: DesiredChannelEntry,
): entry is DesiredCategoryGroup {
  return "category" in entry;
}

export interface DesiredAgentBinding {
  channel: string | string[];
  requireMention?: boolean;
}

export interface DesiredAgentBindingItem {
  channel: string;
  requireMention?: boolean;
}

export type AgentBindingValue = string | (string | DesiredAgentBindingItem)[] | DesiredAgentBinding;

export function isAgentBindingObject(
  value: AgentBindingValue,
): value is DesiredAgentBinding {
  return typeof value === "object" && !Array.isArray(value) && "channel" in value;
}

export interface DesiredOpenClaw {
  requireMention?: boolean;
  agents: Record<string, AgentBindingValue>;
}

export interface DesiredState {
  version: 1;
  managedBy: "disclaw";
  guild: string;
  channels: DesiredChannelEntry[];
  openclaw?: DesiredOpenClaw;
  warnings?: string[];
}

// -- Flattened helpers (extracted from nested v2 structure) --

export interface FlatDesiredChannel {
  name: string;
  topic?: string;
  restricted?: boolean;
  categoryName?: string;
}

export interface FlatDesiredThread {
  parentChannel: string;
  name: string;
}

export interface FlatDesiredBinding {
  agentName: string;
  channelRef: string;
  requireMention?: boolean;
}

export interface FlatDesiredState {
  categories: string[];
  channels: FlatDesiredChannel[];
  threads: FlatDesiredThread[];
  bindings: FlatDesiredBinding[];
}

// -- Actual state (fetched from providers) --

export interface ActualChannel {
  id: string;
  name: string;
  type: "text";
  topic?: string;
  restricted?: boolean;
  categoryId?: string;
  managedBy?: string;
}

export interface ActualCategory {
  id: string;
  name: string;
  managedBy?: string;
}

export interface ActualThread {
  id: string;
  name: string;
  parentChannelId: string;
  managedBy?: string;
}

export interface ActualPin {
  messageId: string;
  channelId: string;
  content: string;
  managedBy?: string;
}

export interface ActualBinding {
  agentId: string;
  match: {
    channel: string;
    peer: { kind: string; id: string };
  };
}

export interface DiscordState {
  categories: ActualCategory[];
  channels: ActualChannel[];
  threads: ActualThread[];
  pins: ActualPin[];
}

export interface OpenClawState {
  bindings: ActualBinding[];
}

export interface UnmanagedResource {
  resourceType: ResourceType;
  name: string;
  id: string;
  topic?: string;
}

export interface ReconcileResult {
  actions: Action[];
  unmanaged: UnmanagedResource[];
}

export interface Snapshot {
  timestamp: string;
  configHash: string;
  discord: DiscordState;
  openclaw: OpenClawState;
}

export type ResourceTypeFilter = Set<ResourceType>;

const ALL_RESOURCE_TYPES: ResourceType[] = ["category", "channel", "thread", "binding"];

export function parseTypeFilter(raw?: string): ResourceTypeFilter | null {
  if (!raw) return null;
  const types = raw.split(",").map((s) => s.trim()).filter(Boolean) as ResourceType[];
  for (const t of types) {
    if (!ALL_RESOURCE_TYPES.includes(t)) {
      throw new Error(`Unknown resource type "${t}". Valid types: ${ALL_RESOURCE_TYPES.join(", ")}`);
    }
  }
  return new Set(types);
}

export interface DirOptions {
  baseDir: string;
  configPath: string;
  snapshotDir: string;
}

export function resolveDirOptions(opts: { dir?: string; config?: string }): DirOptions {
  // Explicit -c flag — use it directly, snapshots go to sibling dir
  if (opts.config) {
    const baseDir = opts.dir ?? process.env.DISCLAW_DIR ?? join(opts.config, "..");
    return { baseDir, configPath: opts.config, snapshotDir: join(baseDir, "snapshots") };
  }

  // --dir or DISCLAW_DIR
  if (opts.dir || process.env.DISCLAW_DIR) {
    const baseDir = (opts.dir ?? process.env.DISCLAW_DIR)!;
    return { baseDir, configPath: join(baseDir, "disclaw.yaml"), snapshotDir: join(baseDir, "snapshots") };
  }

  // Fall back to ~/.config/disclaw/
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  const baseDir = join(homeDir, ".config", "disclaw");
  return { baseDir, configPath: join(baseDir, "disclaw.yaml"), snapshotDir: join(baseDir, "snapshots") };
}

export interface GatewayOptions {
  gatewayUrl: string;
  gatewayToken: string;
}

export function resolveGatewayOptions(opts: { gatewayUrl?: string; gatewayToken?: string }): GatewayOptions {
  return {
    gatewayUrl: opts.gatewayUrl ?? process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
    gatewayToken: opts.gatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
  };
}
