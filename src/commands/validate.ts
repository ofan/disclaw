// src/commands/validate.ts
import { readFileSync } from "node:fs";
import { parseConfig, flattenDesiredState } from "../parser.ts";
import type { DesiredState } from "../types.ts";

export function validateCommand(configPath: string, json: boolean = false): number {
  const raw = readFileSync(configPath, "utf-8");
  const config = parseConfig(raw);

  if (json) {
    const serverDetails: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(config.servers)) {
      const state: DesiredState = {
        version: 1, managedBy: "disclaw",
        guild: server.guild, channels: server.channels, openclaw: server.openclaw,
      };
      const flat = flattenDesiredState(state);
      serverDetails[name] = {
        guild: server.guild,
        categories: flat.categories.length,
        channels: flat.channels.length,
        threads: flat.threads.length,
        bindings: flat.bindings.length,
        ...(server.warnings?.length ? { warnings: server.warnings } : {}),
      };
    }
    console.log(JSON.stringify({
      valid: !config.warnings?.length,
      servers: Object.keys(config.servers),
      ...(config.warnings?.length ? { warnings: config.warnings } : {}),
      details: serverDetails,
    }, null, 2));
    return config.warnings?.length ? 1 : 0;
  }

  // Human-readable output
  for (const [name, server] of Object.entries(config.servers)) {
    const state: DesiredState = {
      version: 1, managedBy: "disclaw",
      guild: server.guild, channels: server.channels, openclaw: server.openclaw,
    };
    const flat = flattenDesiredState(state);

    if (server.warnings?.length) {
      for (const w of server.warnings) console.log(`\u26A0 ${config.singleServer ? "" : name + ": "}${w}`);
    }

    const prefix = config.singleServer ? "" : `${name}: `;
    console.log(`\u2713 ${prefix}${flat.categories.length} categories, ${flat.channels.length} channels, ${flat.threads.length} threads, ${flat.bindings.length} bindings`);
  }

  if (config.warnings?.length) {
    return 1;
  }

  const serverCount = Object.keys(config.servers).length;
  console.log(`\u2713 Config valid${serverCount > 1 ? ` (${serverCount} servers)` : ""}`);
  return 0;
}
