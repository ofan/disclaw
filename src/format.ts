// src/format.ts
import chalk from "chalk";
import type { Action, ActualPin, ActualChannel, UnmanagedResource } from "./types.ts";

export interface DiffJsonInput {
  actions: Action[];
  unmanaged: UnmanagedResource[];
  unboundAgents: string[];
  staleAgents: string[];
  pins: ActualPin[];
  channels: ActualChannel[];
}

export interface DiffJsonEntry {
  op: string;
  type: string;
  name: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  count?: number;
  status?: string;
}

export function toDiffJson(input: DiffJsonInput): DiffJsonEntry[] {
  const entries: DiffJsonEntry[] = [];

  // Actions
  for (const a of input.actions) {
    const entry: DiffJsonEntry = { op: a.type, type: a.resourceType, name: a.name };
    if (a.details?.before) entry.before = a.details.before;
    if (a.details?.after) entry.after = a.details.after;
    entries.push(entry);
  }

  // Unmanaged
  for (const r of input.unmanaged) {
    entries.push({ op: "unmanaged", type: r.resourceType, name: r.name });
  }

  // Agents
  for (const a of input.unboundAgents) {
    entries.push({ op: "unbound", type: "agent", name: a });
  }
  for (const a of input.staleAgents) {
    entries.push({ op: "stale", type: "agent", name: a });
  }

  // Pins (grouped by channel)
  const byChannel = new Map<string, number>();
  for (const pin of input.pins) {
    const ch = input.channels.find((c) => c.id === pin.channelId);
    const name = ch?.name ?? "unknown";
    byChannel.set(name, (byChannel.get(name) ?? 0) + 1);
  }
  for (const [name, count] of [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    entries.push({ op: "pin", type: "pin", name, count });
  }

  return entries;
}

export function formatActions(actions: Action[]): string {
  const grouped = {
    create: actions.filter((a) => a.type === "create"),
    update: actions.filter((a) => a.type === "update"),
    delete: actions.filter((a) => a.type === "delete"),
    noop: actions.filter((a) => a.type === "noop"),
  };

  const lines: string[] = [];
  lines.push("");

  if (grouped.create.length) {
    lines.push(chalk.green.bold("  + Create:"));
    for (const a of grouped.create) {
      lines.push(chalk.green(`    + ${a.resourceType} "${a.name}"`));
    }
  }

  if (grouped.update.length) {
    lines.push(chalk.yellow.bold("  ~ Update:"));
    for (const a of grouped.update) {
      lines.push(chalk.yellow(`    ~ ${a.resourceType} "${a.name}"`));
      if (a.details?.before && a.details?.after) {
        for (const key of Object.keys(a.details.after)) {
          const before = (a.details.before as Record<string, unknown>)[key];
          const after = (a.details.after as Record<string, unknown>)[key];
          if (before !== after) {
            lines.push(chalk.red(`      - ${key}: ${before}`));
            lines.push(chalk.green(`      + ${key}: ${after}`));
          }
        }
      }
    }
  }

  if (grouped.delete.length) {
    lines.push(chalk.red.bold("  - Delete:"));
    for (const a of grouped.delete) {
      const warn = a.resourceType !== "binding"
        ? chalk.red("  ⚠ permanent — messages cannot be recovered")
        : "";
      lines.push(chalk.red(`    - ${a.resourceType} "${a.name}"`) + warn);
    }
  }

  if (grouped.noop.length) {
    lines.push(chalk.dim(`  = Unchanged: ${grouped.noop.length} resources`));
  }

  const changeCount = grouped.create.length + grouped.update.length + grouped.delete.length;
  lines.push("");
  lines.push(
    changeCount === 0
      ? chalk.green("  No changes needed.")
      : `  ${chalk.bold(`${changeCount} change(s)`)} to apply.`,
  );
  lines.push("");

  return lines.join("\n");
}

export function formatUnmanaged(unmanaged: UnmanagedResource[]): string {
  if (unmanaged.length === 0) return "";
  const lines: string[] = [];
  lines.push(chalk.cyan.bold("  ? Unmanaged (in Discord but not in config):"));
  for (const r of unmanaged) {
    const extra = r.topic ? ` — "${r.topic}"` : "";
    lines.push(chalk.cyan(`    ? ${r.resourceType} "${r.name}"${extra}`));
  }
  lines.push(chalk.dim("    To import: disclaw import -c disclaw.yaml"));
  lines.push(chalk.dim("    To delete: disclaw apply --prune -c disclaw.yaml"));
  lines.push("");
  return lines.join("\n");
}

export function formatDriftWarnings(
  snapshotActions: Action[],
  currentActions: Action[],
): string {
  const lines: string[] = [];
  for (const sa of snapshotActions) {
    const ca = currentActions.find(
      (c) => c.resourceType === sa.resourceType && c.name === sa.name,
    );
    if (ca && ca.type !== sa.type) {
      lines.push(
        chalk.yellow(
          `  ⚠ DRIFT: ${sa.resourceType} "${sa.name}" — expected ${sa.type}, found ${ca.type}`,
        ),
      );
    }
  }
  return lines.length > 0
    ? chalk.yellow.bold("\n  ⚠ Drift detected:\n") + lines.join("\n") + "\n"
    : "";
}

export function formatPinSummary(pins: ActualPin[], channels: ActualChannel[]): string {
  if (pins.length === 0) return "";
  const lines: string[] = [];
  lines.push(chalk.dim("  Pins (read-only):"));

  // Group pins by channel
  const byChannel = new Map<string, number>();
  for (const pin of pins) {
    const ch = channels.find((c) => c.id === pin.channelId);
    const name = ch?.name ?? "unknown";
    byChannel.set(name, (byChannel.get(name) ?? 0) + 1);
  }

  for (const [name, count] of [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(chalk.dim(`    ${name}: ${count} pin(s)`));
  }
  lines.push("");
  return lines.join("\n");
}

export function formatUnboundAgents(agents: string[]): string {
  if (agents.length === 0) return "";
  const lines: string[] = [];
  lines.push(chalk.cyan.bold("  ? Unbound agents (in OpenClaw but not in config):"));
  for (const a of agents.sort()) {
    lines.push(chalk.cyan(`    ? ${a}`));
  }
  lines.push("");
  return lines.join("\n");
}

export function formatStaleAgents(agents: string[]): string {
  if (agents.length === 0) return "";
  const lines: string[] = [];
  lines.push(chalk.yellow.bold("  ⚠ Stale agents (in config but not in OpenClaw):"));
  for (const a of agents.sort()) {
    lines.push(chalk.yellow(`    ⚠ ${a}`));
  }
  lines.push("");
  return lines.join("\n");
}
