#!/usr/bin/env node
// src/cli.ts
import { Command } from "commander";
import { diffCommand } from "./commands/diff.ts";
import { applyCommand } from "./commands/apply.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { importCommand } from "./commands/import.ts";
import { validateCommand } from "./commands/validate.ts";
import { resolveDirOptions, resolveGatewayOptions, parseTypeFilter } from "./types.ts";
import { VERSION } from "./version.ts";

const program = new Command();

program
  .name("disclaw")
  .description("Manage Discord workspace structure and OpenClaw routing as code")
  .version(VERSION)
  .option("--dir <dir>", "Base directory for config and snapshots (default: ~/.config/disclaw)")
  .option("--gateway-url <url>", "OpenClaw gateway URL (default: http://127.0.0.1:18789)")
  .option("--gateway-token <token>", "OpenClaw gateway auth token");

function addCommonFlags(cmd: Command): Command {
  return cmd
    .option("-f, --filters <types>", "Filter by resource type (comma-separated: category,channel,thread,binding)")
    .option("-j, --json", "Output as JSON (no colors)", false);
}

const diffCmd = program
  .command("diff")
  .description("Show full diff between config and current state")
  .option("-c, --config <path>", "Path to disclaw.yaml config file");
addCommonFlags(diffCmd)
  .action(async (opts) => {
    const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${dirOpts.configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await diffCommand(dirOpts.configPath, filter, opts.json, gwOpts);
    process.exit(code);
  });

const applyCmd = program
  .command("apply")
  .description("Apply desired state changes (dry-run by default)")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-y, --yes", "Actually apply changes (default is dry-run)", false)
  .option("--prune", "Delete resources not in config (channels, categories, threads)", false);
addCommonFlags(applyCmd)
  .action(async (opts) => {
    const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${dirOpts.configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await applyCommand(dirOpts.configPath, opts.yes, filter, opts.json, opts.prune, gwOpts, dirOpts.snapshotDir);
    process.exit(code);
  });

const rollbackCmd = program
  .command("rollback")
  .description("Restore from most recent pre-apply snapshot")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-y, --yes", "Actually rollback (default is dry-run)", false);
addCommonFlags(rollbackCmd)
  .action(async (opts) => {
    const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
    if (!opts.json) console.log(`Config: ${dirOpts.configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await rollbackCommand(dirOpts.configPath, opts.yes, opts.json, gwOpts, dirOpts.snapshotDir);
    process.exit(code);
  });

const importCmd = program
  .command("import")
  .description("Import unmanaged Discord resources into config")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-y, --yes", "Actually import (default is dry-run)", false);
addCommonFlags(importCmd)
  .action(async (opts) => {
    const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${dirOpts.configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await importCommand(dirOpts.configPath, opts.yes, filter, opts.json, gwOpts);
    process.exit(code);
  });

program
  .command("validate")
  .description("Validate config file (no API calls — safe for CI)")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-j, --json", "Output as JSON", false)
  .action((opts) => {
    try {
      const dirOpts = resolveDirOptions({ dir: program.opts().dir, config: opts.config });
      if (!opts.json) console.log(`Config: ${dirOpts.configPath}`);
      const code = validateCommand(dirOpts.configPath, opts.json);
      process.exit(code);
    } catch (err: unknown) {
      if (opts.json) {
        console.log(JSON.stringify({
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

process.on("unhandledRejection", (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ConnectTimeout") || msg.includes("CONNECT_TIMEOUT")) {
    console.error("Error: Discord connection timed out. Check your network and try again.");
  } else if (msg.includes("TOKEN_INVALID") || msg.includes("An invalid token was provided")) {
    console.error("Error: Invalid Discord bot token. Check DISCORD_BOT_TOKEN or OpenClaw config.");
  } else {
    console.error(`Error: ${msg}`);
  }
  process.exit(1);
});

program.parse();
