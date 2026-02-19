import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./types.ts";

const DEFAULT_DIR = ".disclaw/snapshots";

export async function saveSnapshot(
  snapshot: Snapshot,
  dir: string = DEFAULT_DIR,
): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${now}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(snapshot, null, 2));
  return filepath;
}

export async function loadLatestSnapshot(
  dir: string = DEFAULT_DIR,
): Promise<Snapshot | null> {
  const snapshots = await listSnapshots(dir);
  if (snapshots.length === 0) return null;
  const raw = readFileSync(snapshots[0], "utf-8");
  return JSON.parse(raw) as Snapshot;
}

export async function listSnapshots(
  dir: string = DEFAULT_DIR,
): Promise<string[]> {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f) => join(dir, f));
    return files;
  } catch {
    return [];
  }
}
