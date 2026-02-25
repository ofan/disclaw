import { createHash } from "node:crypto";
import { hostname, platform, userInfo } from "node:os";
import { createRelay, type Relay } from "@ofan/telemetry-relay-sdk";
import { VERSION } from "./version.ts";

const DISABLED_VALUES = new Set(["0", "false", "off"]);

export function isEnabled(): boolean {
  const val = process.env.DISCLAW_TELEMETRY;
  if (val !== undefined && DISABLED_VALUES.has(val.toLowerCase())) return false;
  return true;
}

let cachedMachineId: string | undefined;

export function getMachineId(): string {
  if (cachedMachineId) return cachedMachineId;
  const raw = hostname() + userInfo().username;
  cachedMachineId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return cachedMachineId;
}

const RELAY_URL = process.env.DISCLAW_TELEMETRY_URL ?? "https://telemetry-relay.ryan-b4e.workers.dev";
const DEFAULT_TOKEN_B64 = "cmxfN0h6LVFsak1VMW8zRnI5cVpqVEZ4eGdRMXROc2FlLUlmUnBXWWZYaHhXSQ==";

let relay: Relay | undefined;
let tokenWarned = false;

function getRelay(): Relay | undefined {
  const token = process.env.DISCLAW_TELEMETRY_TOKEN ?? Buffer.from(DEFAULT_TOKEN_B64, "base64").toString();
  if (!token) {
    if (!tokenWarned) {
      console.warn("Warning: DISCLAW_TELEMETRY_TOKEN not set — telemetry disabled");
      tokenWarned = true;
    }
    return undefined;
  }
  if (!relay) relay = createRelay({ url: RELAY_URL, token });
  return relay;
}

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
}

const queue: QueuedEvent[] = [];

export function track(event: string, properties: Record<string, unknown> = {}): void {
  if (!isEnabled()) return;
  queue.push({
    event,
    properties: {
      ...properties,
      os: platform(),
      nodeVersion: process.version,
      ci: process.env.CI === "true",
    },
  });
}

type CommandOpts = Record<string, unknown>;

export function withTelemetry(
  commandName: string,
  fn: (opts: CommandOpts) => Promise<number>,
): (opts: CommandOpts) => Promise<number> {
  return async (opts) => {
    const commonProps = {
      command: commandName,
      json: Boolean(opts.json),
      filters: opts.filters ?? null,
      server: opts.server ?? null,
    };
    track("command_run", commonProps);
    const start = performance.now();
    const exitCode = await fn(opts);
    const durationMs = Math.round(performance.now() - start);
    track("command_done", { ...commonProps, exitCode, durationMs });
    await flush();
    return exitCode;
  };
}

const FLUSH_TIMEOUT_MS = 1000;

export async function flush(): Promise<void> {
  if (!isEnabled() || queue.length === 0) return;
  const events = queue.splice(0);
  const r = getRelay();
  if (!r) return;
  const machineId = getMachineId();
  try {
    await Promise.race([
      Promise.all(
        events.map((e) =>
          r.track("disclaw", e.event, VERSION, { ...e.properties, machineId }),
        ),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("flush timeout")), FLUSH_TIMEOUT_MS),
      ),
    ]);
  } catch {
    // Telemetry must never break the CLI
  }
}
