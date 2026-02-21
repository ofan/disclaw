import { basename, dirname, extname, join } from "node:path";

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
  private?: boolean;
  addBot?: boolean;
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

// -- Multi-server types --

export interface ServerConfig {
  guild: string;
  channels: DesiredChannelEntry[];
  openclaw?: DesiredOpenClaw;
  warnings?: string[];
}

export interface ParsedConfig {
  servers: Record<string, ServerConfig>;
  singleServer: boolean;
  warnings?: string[];
}

export interface MultiServerSnapshot {
  timestamp: string;
  configHash: string;
  servers: Record<string, { guildId: string; discord: DiscordState }>;
  openclaw: OpenClawState;
}

// -- Flattened helpers (extracted from nested v2 structure) --

export interface FlatDesiredChannel {
  name: string;
  topic?: string;
  restricted?: boolean;
  private?: boolean;
  addBot?: boolean;
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
  private?: boolean;
  addBot?: boolean;
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

// -- Config / snapshot resolution (multi-server) --

export function resolveConfigPath(opts: { config?: string }): string {
  if (opts.config) return opts.config;
  const envPath = process.env.DISCLAW_CONFIG;
  if (envPath) return envPath;
  return join(process.cwd(), "disclaw.yaml");
}

export interface SnapshotOptions {
  enabled: boolean;
  path: string;
}

export function resolveSnapshotOptions(opts: {
  snapshot?: string;
  noSnapshot?: boolean;
  configPath: string;
}): SnapshotOptions {
  if (opts.noSnapshot) return { enabled: false, path: "" };
  if (opts.snapshot) return { enabled: true, path: opts.snapshot };
  const envVal = process.env.DISCLAW_SNAPSHOT;
  if (envVal && ["off", "false", "0"].includes(envVal.toLowerCase())) {
    return { enabled: false, path: "" };
  }
  if (envVal) return { enabled: true, path: envVal };
  return { enabled: true, path: resolveSnapshotPath(opts.configPath) };
}

export function resolveSnapshotPath(configPath: string): string {
  const dir = dirname(configPath);
  const ext = extname(configPath);
  const base = basename(configPath, ext);
  const slugified = base.replace(/\./g, "-");
  return join(dir, `${slugified}-snapshot.json`);
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
