// src/commands/validate.ts
import { readFileSync } from "node:fs";
import { parseConfig, flattenDesiredState } from "../parser.ts";

export function validateCommand(configPath: string, json: boolean = false): number {
  const raw = readFileSync(configPath, "utf-8");
  const desired = parseConfig(raw);
  const flat = flattenDesiredState(desired);

  const warnings = desired.warnings ?? [];

  if (json) {
    console.log(JSON.stringify({
      valid: true,
      warnings,
      categories: flat.categories.length,
      channels: flat.channels.length,
      threads: flat.threads.length,
      bindings: flat.bindings.length,
    }, null, 2));
  } else {
    for (const w of warnings) console.log(`\u26A0 ${w}`);
    console.log(`\u2713 Config valid: ${configPath}`);
    console.log(`  ${flat.categories.length} categories, ${flat.channels.length} channels, ${flat.threads.length} threads, ${flat.bindings.length} bindings`);
  }

  return warnings.length > 0 ? 1 : 0;
}
