#!/usr/bin/env node
// src/cli.ts
import { Command } from "commander";
import { diffCommand } from "./commands/diff.ts";
import { applyCommand } from "./commands/apply.ts";
import { rollbackCommand } from "./commands/rollback.ts";
import { importCommand } from "./commands/import.ts";
import { validateCommand } from "./commands/validate.ts";
import { resolveConfigPath, resolveSnapshotOptions, resolveGatewayOptions, parseTypeFilter } from "./types.ts";
import { VERSION } from "./version.ts";
import { withTelemetry } from "./telemetry.ts";

const program = new Command();

program
  .name("disclaw")
  .description("Manage Discord workspace structure and OpenClaw routing as code")
  .version(VERSION)
  .option("--gateway-url <url>", "OpenClaw gateway URL (default: http://127.0.0.1:18789)")
  .option("--gateway-token <token>", "OpenClaw gateway auth token");

function addCommonFlags(cmd: Command): Command {
  return cmd
    .option("-f, --filters <types>", "Filter by resource type (comma-separated: category,channel,thread,binding)")
    .option("-j, --json", "Output as JSON (no colors)", false);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(name: string, fn: (opts: any) => Promise<number>) {
  const wrapped = withTelemetry(name, fn);
  return async (...args: unknown[]) => {
    const code = await wrapped(args[0] as Record<string, unknown>);
    process.exit(code);
  };
}

const diffCmd = program
  .command("diff")
  .description("Show full diff between config and current state")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-s, --server <name>", "Target a specific server");
addCommonFlags(diffCmd)
  .action(run("diff", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await diffCommand(configPath, filter, opts.json, gwOpts, opts.server);
    return code;
  }));

const applyCmd = program
  .command("apply")
  .description("Apply desired state changes (dry-run by default)")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-s, --server <name>", "Target a specific server")
  .option("-y, --yes", "Actually apply changes (default is dry-run)", false)
  .option("--prune", "Delete resources not in config (channels, categories, threads)", false)
  .option("--no-snapshot", "Skip saving snapshot before apply")
  .option("--snapshot <path>", "Custom snapshot file path");
addCommonFlags(applyCmd)
  .action(run("apply", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const snapOpts = resolveSnapshotOptions({
      snapshot: typeof opts.snapshot === "string" ? opts.snapshot : undefined,
      noSnapshot: opts.snapshot === false,
      configPath,
    });
    const code = await applyCommand(configPath, opts.yes, filter, opts.json, opts.prune, gwOpts, snapOpts, opts.server);
    return code;
  }));

const rollbackCmd = program
  .command("rollback")
  .description("Restore from most recent pre-apply snapshot")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-s, --server <name>", "Target a specific server")
  .option("-y, --yes", "Actually rollback (default is dry-run)", false)
  .option("--no-snapshot", "Skip saving pre-rollback snapshot")
  .option("--snapshot <path>", "Custom snapshot file path");
addCommonFlags(rollbackCmd)
  .action(run("rollback", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config });
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const snapOpts = resolveSnapshotOptions({
      snapshot: typeof opts.snapshot === "string" ? opts.snapshot : undefined,
      noSnapshot: opts.snapshot === false,
      configPath,
    });
    const code = await rollbackCommand(configPath, opts.yes, opts.json, gwOpts, snapOpts, opts.server);
    return code;
  }));

const importCmd = program
  .command("import")
  .description("Import unmanaged Discord resources into config")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-s, --server <name>", "Target a specific server")
  .option("-y, --yes", "Actually import (default is dry-run)", false);
addCommonFlags(importCmd)
  .action(run("import", async (opts) => {
    const configPath = resolveConfigPath({ config: opts.config });
    const filter = parseTypeFilter(opts.filters);
    if (!opts.json) console.log(`Config: ${configPath}`);
    const gwOpts = resolveGatewayOptions(program.opts());
    const code = await importCommand(configPath, opts.yes, filter, opts.json, gwOpts, opts.server);
    return code;
  }));

program
  .command("validate")
  .description("Validate config file (no API calls — safe for CI)")
  .option("-c, --config <path>", "Path to disclaw.yaml config file")
  .option("-j, --json", "Output as JSON", false)
  .action(run("validate", async (opts) => {
    try {
      const configPath = resolveConfigPath({ config: opts.config });
      if (!opts.json) console.log(`Config: ${configPath}`);
      const code = validateCommand(configPath, opts.json);
      return code;
    } catch (err: unknown) {
      if (opts.json) {
        console.log(JSON.stringify({
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 1;
    }
  }));

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
