import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseConfig } from "./parser.ts";
import { reconcile } from "./reconciler.ts";
import { DiscordProvider } from "./providers/discord.ts";
import { OpenClawCLIProvider, probeOpenClawCLI } from "./providers/openclaw.ts";
import { formatActions } from "./format.ts";
import type { DesiredState, OpenClawState } from "./types.ts";

describe("integration: plan against real state", () => {
  const configPath = "disclaw.yaml";
  let discordProvider: DiscordProvider;

  before(async function () {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.log("Skipping integration test — DISCORD_BOT_TOKEN not set");
      return;
    }
    const raw = readFileSync(configPath, "utf-8");
    const config = parseConfig(raw);
    const server = config.servers[Object.keys(config.servers)[0]];
    discordProvider = new DiscordProvider(
      process.env.DISCORD_BOT_TOKEN,
      server.guild,
    );
    await discordProvider.login();
  });

  after(async () => {
    if (discordProvider) await discordProvider.destroy();
  });

  it("fetches Discord state and produces a plan", async function () {
    if (!process.env.DISCORD_BOT_TOKEN) return;

    const raw = readFileSync(configPath, "utf-8");
    const config = parseConfig(raw);
    const server = config.servers[Object.keys(config.servers)[0]];
    const desired: DesiredState = {
      version: 1, managedBy: "disclaw",
      guild: server.guild, channels: server.channels, openclaw: server.openclaw,
    };
    const discordState = await discordProvider.fetch();

    let openclawState: OpenClawState = { bindings: [] };
    if (await probeOpenClawCLI()) {
      const oc = new OpenClawCLIProvider();
      openclawState = await oc.fetch();
    }

    const { actions } = reconcile(desired, discordState, openclawState);
    console.log(formatActions(actions));

    assert.ok(Array.isArray(actions));
    assert.ok(actions.length > 0);
    for (const a of actions) {
      assert.ok(["create", "update", "delete", "noop"].includes(a.type));
    }
  });
});
