import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseToolsInvokeResponse, parseConfigGetResponse, OpenClawAPIProvider, probeGatewayAPI } from "./openclaw.ts";

describe("parseToolsInvokeResponse", () => {
  it("extracts content text from successful response", () => {
    const response = {
      ok: true,
      result: {
        content: [{ type: "text", text: '{"agents":[{"id":"main"}]}' }],
      },
    };
    const result = parseToolsInvokeResponse(response);
    assert.deepEqual(result, { agents: [{ id: "main" }] });
  });

  it("throws on error response", () => {
    const response = { ok: false, error: { type: "not_found", message: "Tool not available" } };
    assert.throws(
      () => parseToolsInvokeResponse(response),
      { message: /Tool not available/ },
    );
  });

  it("throws on missing content", () => {
    const response = { ok: true, result: { content: [] } };
    assert.throws(
      () => parseToolsInvokeResponse(response),
      { message: /empty/ },
    );
  });
});

describe("parseConfigGetResponse", () => {
  it("extracts bindings from full config", () => {
    const configGetResult = {
      exists: true,
      hash: "abc123",
      raw: JSON.stringify({
        bindings: [
          { agentId: "main", match: { channel: "discord", peer: { kind: "channel", id: "999" } } },
        ],
        channels: { discord: { token: "tok_secret" } },
      }),
    };
    const parsed = parseConfigGetResponse(configGetResult);
    assert.equal(parsed.hash, "abc123");
    assert.equal(parsed.bindings.length, 1);
    assert.equal(parsed.bindings[0].agentId, "main");
    assert.equal(parsed.discordToken, "tok_secret");
  });

  it("returns empty bindings when key is missing", () => {
    const configGetResult = {
      exists: true,
      hash: "abc123",
      raw: JSON.stringify({ channels: {} }),
    };
    const parsed = parseConfigGetResponse(configGetResult);
    assert.equal(parsed.bindings.length, 0);
    assert.equal(parsed.discordToken, undefined);
  });

  it("extracts guild routing config", () => {
    const configGetResult = {
      exists: true,
      hash: "abc123",
      raw: JSON.stringify({
        bindings: [],
        channels: {
          discord: {
            guilds: {
              "guild1": {
                channels: { "ch1": { allow: true } },
              },
            },
          },
        },
      }),
    };
    const parsed = parseConfigGetResponse(configGetResult);
    const routing = parsed.getGuildRouting("guild1");
    assert.deepEqual(routing.channels, { ch1: { allow: true } });
  });

  it("returns empty routing for missing guild", () => {
    const configGetResult = {
      exists: true,
      hash: "abc123",
      raw: JSON.stringify({ bindings: [] }),
    };
    const parsed = parseConfigGetResponse(configGetResult);
    const routing = parsed.getGuildRouting("guild1");
    assert.deepEqual(routing, { channels: {} });
  });
});

describe("OpenClawAPIProvider", () => {
  it("fetch() returns bindings from config.get", async (t) => {
    const mockConfig = {
      bindings: [
        { agentId: "main", match: { channel: "discord", peer: { kind: "channel", id: "123" } } },
      ],
    };
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          exists: true,
          hash: "abc",
          raw: JSON.stringify(mockConfig),
        }) }],
      },
    }));

    const provider = new OpenClawAPIProvider({ gatewayUrl: "http://localhost:1", gatewayToken: "tok" });
    const state = await provider.fetch();
    assert.equal(state.bindings.length, 1);
    assert.equal(state.bindings[0].agentId, "main");
  });

  it("fetchAgents() returns agent IDs", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          requester: "main",
          agents: [{ id: "main", configured: true }, { id: "coder", configured: true }],
        }) }],
      },
    }));

    const provider = new OpenClawAPIProvider({ gatewayUrl: "http://localhost:1", gatewayToken: "tok" });
    const agents = await provider.fetchAgents();
    assert.deepEqual(agents, ["main", "coder"]);
  });
});

describe("probeGatewayAPI", () => {
  it("returns false when gateway is unreachable", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

    const result = await probeGatewayAPI({ gatewayUrl: "http://localhost:99999", gatewayToken: "tok" });
    assert.equal(result, false);
  });

  it("returns false when auth fails (401)", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response('{"error":"unauthorized"}', { status: 401 });

    const result = await probeGatewayAPI({ gatewayUrl: "http://localhost:1", gatewayToken: "bad" });
    assert.equal(result, false);
  });

  it("returns false when gateway tool is not allowed (404)", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response('{"error":"not found"}', { status: 404 });

    const result = await probeGatewayAPI({ gatewayUrl: "http://localhost:1", gatewayToken: "tok" });
    assert.equal(result, false);
  });

  it("returns true when config.get succeeds", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      result: { content: [{ type: "text", text: JSON.stringify({ exists: true, hash: "h", raw: "{}" }) }] },
    }));

    const result = await probeGatewayAPI({ gatewayUrl: "http://localhost:1", gatewayToken: "tok" });
    assert.equal(result, true);
  });

  it("returns false when no token provided", async () => {
    const result = await probeGatewayAPI({ gatewayUrl: "http://localhost:1", gatewayToken: "" });
    assert.equal(result, false);
  });
});
