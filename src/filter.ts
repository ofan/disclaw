import chalk from "chalk";
import type { Action, UnmanagedResource, ResourceTypeFilter } from "./types.ts";

export function filterActions(actions: Action[], filter: ResourceTypeFilter | null): Action[] {
  if (!filter) return actions;
  return actions.filter((a) => filter.has(a.resourceType));
}

export function filterUnmanaged(unmanaged: UnmanagedResource[], filter: ResourceTypeFilter | null): UnmanagedResource[] {
  if (!filter) return unmanaged;
  return unmanaged.filter((r) => filter.has(r.resourceType));
}

export function filterAgents(agents: string[], filter: ResourceTypeFilter | null): string[] {
  if (!filter) return agents;
  return filter.has("binding") ? agents : [];
}

export function filterSummary(showing: number, total: number, filter: ResourceTypeFilter | null): string {
  if (!filter) return "";
  const hidden = total - showing;
  const types = [...filter].join(", ");
  return chalk.dim(`  (filtered: showing ${showing} of ${total} resources — ${hidden} hidden by -f ${types})`);
}
