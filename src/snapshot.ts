import { readFileSync, writeFileSync } from "node:fs";
import type { MultiServerSnapshot } from "./types.ts";

export function saveSnapshot(snapshot: MultiServerSnapshot, path: string): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export function loadSnapshot(path: string): MultiServerSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    // Migration shim: old format has discord: at top level
    if (raw.discord && !raw.servers) {
      return {
        timestamp: raw.timestamp,
        configHash: raw.configHash,
        servers: {
          default: { guildId: "unknown", discord: raw.discord },
        },
        openclaw: raw.openclaw,
      };
    }
    return raw as MultiServerSnapshot;
  } catch {
    return null;
  }
}
